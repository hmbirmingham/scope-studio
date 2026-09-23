import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { costUsd, priceFor } from '../../src/lib/anthropic.js';
import { parseNdjson } from '../../src/lib/ollama.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeAnthropic } from '../fakeAnthropic.js';
import { startFakeOllama } from '../fakeOllama.js';
import { ensureCentroids, registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const KEY = 'sk-ant-test-not-a-real-key';

describe('cloud tier', () => {
  let server;
  let ollama;
  let anthropic;
  let api;
  let ids;

  const chat = (body, headers = {}) =>
    api.raw('POST', '/api/chat', body, { headers: { 'Content-Type': 'application/json', ...headers } });

  async function readLines(response) {
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  }

  async function metricsRow(queryId) {
    for (let i = 0; i < 100; i++) {
      const { rows } = await server.pool.query('SELECT * FROM query_metrics WHERE query_id = $1', [queryId]);
      if (rows[0]) return rows[0];
      await sleep(20);
    }
    throw new Error('no metrics row');
  }

  before(async () => {
    ollama = await startFakeOllama({ embedUrl: realOllama });
    anthropic = await startFakeAnthropic();
    process.env.OLLAMA_URL = ollama.url;
    process.env.ANTHROPIC_BASE_URL = anthropic.url;
    server = await startServer();
    await ensureCentroids(server.pool);
    api = await registeredSession(server.base);

    const create = async (body) => (await api('POST', '/api/nodes', body)).data;
    const doc = await create({
      type: 'file',
      content: 'docs/pipeline.md\n\nThe ingestion pipeline chunks files, embeds each chunk, and prunes deleted paths.',
      project: 'hmb/docs',
      privacy: 'cloud',
    });
    const secret = await create({
      type: 'file',
      content: 'firmware/secret_motor.c\n\nstepper calibration constants for the unreleased stage',
      project: 'hmb/stage-firmware',
      privacy: 'local',
    });
    ids = { doc: doc.id, secret: secret.id };
  });

  beforeEach(() => {
    resetConversations();
    resetWarmState();
    Object.assign(anthropic.state, { requests: [], authHeaders: [], text: ['Cloud ', 'answer.'], status: 200, outputTokens: 40 });
    Object.assign(ollama.state, { chatRequests: [], tokens: ['Local ', 'answer.'], pauseAfterFirstMs: 0, failAfterFirst: null });
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    delete process.env.ANTHROPIC_BASE_URL;
    await server.close();
    await ollama.close();
    await anthropic.close();
  });

  test('a key on the request makes the cloud tier available and bills what it used', async () => {
    const response = await chat(
      { query: 'how does the ingestion pipeline chunk and prune files', tier: 'cloud_frontier' },
      { 'x-anthropic-api-key': KEY }
    );
    assert.equal(response.status, 200);

    const lines = await readLines(response);
    const [context] = lines;
    assert.equal(context.routing.decision, 'cloud');
    assert.equal(context.routing.reason, 'user_override');
    assert.match(context.routing.model, /^anthropic\/claude-/);
    assert.equal(
      lines.filter((line) => line.type === 'token').map((line) => line.text).join(''),
      'Cloud answer.'
    );

    const done = lines.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.metrics.outputTokens, 40);
    assert.equal(done.metrics.promptTokens, 1200);
    assert.ok(done.metrics.costUsd > 0);

    const [request] = anthropic.state.requests;
    assert.ok(request.system.startsWith('You are Scope Studio'), 'the system prompt goes in its own field');
    assert.ok(request.messages.every((message) => message.role !== 'system'));
    const [cached, question] = request.messages[0].content;
    assert.match(cached.text, /## Context/, 'the cloud tier uses the markdown structure');
    assert.deepEqual(cached.cache_control, { type: 'ephemeral' }, 'the stable context block is the cache breakpoint');
    assert.match(question.text, /^## Question/, 'the volatile question sits after the breakpoint');
    assert.equal(question.cache_control, undefined);
    assert.equal(request.max_tokens, 2048, 'a runaway answer is bounded');
    assert.equal(request.stream, true);
    assert.equal(anthropic.state.authHeaders[0], KEY, 'the key is forwarded, never substituted');
    assert.equal(ollama.state.chatRequests.length, 0, 'nothing went to the local model');

    const row = await metricsRow(done.queryId);
    assert.equal(row.routing_decision, 'cloud');
    assert.match(row.model_used, /^anthropic\//);
    assert.equal(row.output_tokens, 40);
    assert.ok(Number(row.cost_usd) > 0);
  });

  test('the key is never written anywhere', async () => {
    const response = await chat({ query: 'how does the pipeline prune deleted paths', tier: 'cloud_frontier' }, { 'x-anthropic-api-key': KEY });
    const lines = await readLines(response);
    assert.equal(lines.at(-1).type, 'done');

    const { rows } = await server.pool.query(
      `SELECT count(*)::int AS c FROM query_metrics WHERE query_text LIKE '%sk-ant%' OR model_used LIKE '%sk-ant%'`
    );
    assert.equal(rows[0].c, 0);
    const sessions = await server.pool.query(`SELECT count(*)::int AS c FROM session WHERE sess::text LIKE '%sk-ant%'`);
    assert.equal(sessions.rows[0].c, 0, 'the key never reaches the session store');
  });

  test('private context still forces local, even with a valid key', async () => {
    const response = await chat(
      { query: 'stepper calibration constants for the unreleased stage', tier: 'cloud_frontier' },
      { 'x-anthropic-api-key': KEY }
    );
    const lines = await readLines(response);
    assert.equal(lines[0].routing.decision, 'local');
    assert.equal(lines[0].routing.reason, 'privacy_flag');
    assert.equal(anthropic.state.requests.length, 0, 'private context never left for the cloud');
    assert.equal(ollama.state.chatRequests.length, 1);
    assert.equal(lines.at(-1).type, 'done');
  });

  test('without a key the cloud route is refused and says what is missing', async () => {
    const { status, data } = await api('POST', '/api/chat', {
      query: 'how does the ingestion pipeline chunk files',
      tier: 'cloud_frontier',
    });
    assert.equal(status, 503);
    assert.equal(data.code, 'cloud_unavailable');
    assert.match(data.error, /x-anthropic-api-key/);
    assert.equal(anthropic.state.requests.length, 0);
  });

  test('a rejected key is reported as a sentence, not a stack trace', async () => {
    anthropic.state.status = 401;
    const response = await chat({ query: 'how does the pipeline embed each chunk', tier: 'cloud_frontier' }, { 'x-anthropic-api-key': KEY });
    const lines = await readLines(response);
    assert.equal(lines.at(-1).type, 'error');
    assert.match(lines.at(-1).error, /API key was rejected/);
  });

  test('costUsd prices fresh input, cache writes, cache reads and output at their own rates', () => {
    const model = 'claude-sonnet-5';
    const price = priceFor(model);
    assert.equal(costUsd(model, { input_tokens: 1_000_000, output_tokens: 1_000_000 }), price.input + price.output);
    assert.equal(
      costUsd(model, { cache_creation_input_tokens: 1_000_000 }),
      price.input * 1.25,
      'a cache write costs a quarter more than fresh input'
    );
    assert.equal(
      costUsd(model, { cache_read_input_tokens: 1_000_000 }),
      price.input * 0.1,
      'a cache read costs a tenth — this is the margin lever'
    );
    assert.equal(costUsd('some-model-we-do-not-price', { input_tokens: 10 }), null);
  });

  test('a repeated context is billed as a cache read, not fresh input', () => {
    const model = 'claude-sonnet-5';
    const contextTokens = 1800;
    const cold = costUsd(model, { input_tokens: contextTokens, output_tokens: 150 });
    const warm = costUsd(model, { cache_read_input_tokens: contextTokens, output_tokens: 150 });
    assert.ok(warm < cold, `follow-up ${warm} should cost less than first turn ${cold}`);
    assert.ok(cold / warm > 1.9, `caching should roughly halve a follow-up (ratio ${(cold / warm).toFixed(2)})`);
  });
});
