import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { localChatModel, parseNdjson } from '../../src/lib/ollama.js';
import { SYSTEM_PROMPTS } from '../../src/routing/prompt.js';
import { deadUrl, startFakeOllama } from '../fakeOllama.js';
import { ensureCentroids, registeredSession, session, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_TOKENS = ['Returns ', 'a naïve ', 'count — ', 'done.'];

describe('chat routing and streaming', () => {
  let server;
  let fake;
  let api;
  let privateApi;
  let ids;

  const chat = (body, init, as = api) => as.raw('POST', '/api/chat', body, init);
  const accessCount = async (id) =>
    (await server.pool.query('SELECT access_count FROM nodes WHERE id = $1', [id])).rows[0].access_count;

  async function readLines(response) {
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push({ ...line, at: performance.now() });
    return lines;
  }

  // Metrics land after the last token, off the response path — poll for them.
  async function metricsRow(queryId) {
    for (let i = 0; i < 100; i++) {
      const { rows } = await server.pool.query('SELECT * FROM query_metrics WHERE query_id = $1', [queryId]);
      if (rows[0]) return rows[0];
      await sleep(20);
    }
    throw new Error(`no metrics row for ${queryId}`);
  }

  before(async () => {
    fake = await startFakeOllama({ embedUrl: realOllama });
    process.env.OLLAMA_URL = fake.url;
    server = await startServer();
    await ensureCentroids(server.pool);
    api = await registeredSession(server.base);
    privateApi = await registeredSession(server.base);

    const quantifyNode = {
      type: 'file',
      content: 'src/quantify.py\n\ndef quantify_colonies(image):\n    """Returns a dict with colony count, mean area, and the watershed label mask."""',
      project: 'hmb/plates',
      privacy: 'cloud',
    };
    const quantify = (await api('POST', '/api/nodes', quantifyNode)).data;
    // A second owner holds the private firmware. Seven chunks: enough that a
    // cloud-budget pack (10 nodes) and a local-budget pack (5) differ, so the
    // re-pack is observable. Kept apart because the cloud floor (0.5) admits
    // even unrelated code, and any private node in context forces local.
    await privateApi('POST', '/api/nodes', quantifyNode);
    for (let i = 1; i <= 7; i++) {
      await privateApi('POST', '/api/nodes', {
        type: 'file',
        content: `firmware/stepper_${i}.c\n\nstepper calibrate step ${i}: home the stepper against the limit switch and store offset ${i} in flash.`,
        project: 'hmb/stage-firmware',
        privacy: 'local',
      });
    }
    ids = { quantify: quantify.id };
  });

  beforeEach(() => {
    process.env.OLLAMA_URL = fake.url;
    Object.assign(fake.state, {
      models: ['nomic-embed-text:latest', localChatModel()],
      tokens: [...DEFAULT_TOKENS],
      pauseAfterFirstMs: 0,
      failAfterFirst: null,
      chatRequests: [],
      aborted: 0,
    });
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    await server.close();
    await fake.close();
  });

  test('streams a local answer: context line, tokens, done; metrics logged after the stream', async () => {
    const before = await accessCount(ids.quantify);
    const response = await chat({ query: 'what does quantify_colonies return' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);

    const lines = await readLines(response);
    const [context, ...rest] = lines;
    const done = rest.at(-1);
    assert.equal(context.type, 'context');
    assert.deepEqual(context.routing, {
      decision: 'local',
      tier: 'local_7b',
      reason: 'context_size',
      provisionalTier: 'local_7b',
      model: `ollama/${localChatModel()}`,
    });
    assert.equal(context.nodes[0].id, ids.quantify);
    assert.equal(
      rest.filter((line) => line.type === 'token').map((line) => line.text).join(''),
      DEFAULT_TOKENS.join(''),
      'multi-byte tokens split mid-sequence arrive intact'
    );
    assert.equal(done.type, 'done');
    assert.equal(done.queryId, context.queryId);
    assert.equal(done.metrics.outputTokens, DEFAULT_TOKENS.length);
    assert.equal(done.metrics.promptTokens, 321);

    const [request] = fake.state.chatRequests;
    assert.equal(request.model, localChatModel());
    assert.equal(request.stream, true);
    assert.equal(request.think, false);
    assert.equal(request.options.num_ctx, 8192);
    assert.equal(request.messages[0].content, SYSTEM_PROMPTS.strict_xml);
    assert.match(request.messages[1].content, /<source index="1" type="file" project="hmb\/plates">\nsrc\/quantify\.py/);
    assert.ok(request.messages[1].content.endsWith('<question>\nwhat does quantify_colonies return\n</question>'));

    const row = await metricsRow(done.queryId);
    assert.equal(row.routing_decision, 'local');
    assert.equal(row.routing_reason, 'context_size');
    assert.equal(row.model_used, `ollama/${localChatModel()}`);
    assert.equal(row.tier, 'local_7b');
    assert.equal(row.output_tokens, DEFAULT_TOKENS.length);
    assert.ok(row.routing_decision_ms !== null);
    assert.ok(row.ttft_ms !== null && row.ttft_ms <= row.total_response_ms);
    const { rows: logged } = await server.pool.query(
      'SELECT count(*)::int AS c FROM query_context_nodes WHERE query_id = $1',
      [done.queryId]
    );
    assert.equal(logged[0].c, context.nodes.length);
    assert.equal(await accessCount(ids.quantify), before + 1);
  });

  test('tokens are forwarded as the model emits them, not buffered to the end', async () => {
    fake.state.pauseAfterFirstMs = 400;
    const lines = await readLines(await chat({ query: 'quantify_colonies watershed mask details' }));
    const firstToken = lines.find((line) => line.type === 'token');
    const done = lines.at(-1);
    assert.equal(done.type, 'done');
    assert.ok(
      done.at - firstToken.at >= 300,
      `first token arrived ${Math.round(done.at - firstToken.at)} ms before the end; a buffered stream would show ~0`
    );
  });

  test('private context in a cloud-requested query forces local and re-packs under the local budget', async () => {
    const query = 'how does stepper calibrate against the limit switch';
    const cloudPack = await privateApi('POST', '/api/query', { query, tier: 'cloud_frontier' });
    assert.ok(cloudPack.data.nodes.length > 5, `the cloud budget packs more than the local cap (${cloudPack.data.nodes.length})`);

    const response = await chat({ query, tier: 'cloud_frontier' }, {}, privateApi);
    assert.equal(response.status, 200);
    const lines = await readLines(response);
    const [context] = lines;
    assert.equal(context.routing.provisionalTier, 'cloud_frontier');
    assert.equal(context.routing.tier, 'local_7b');
    assert.equal(context.routing.reason, 'privacy_flag');
    assert.ok(context.nodes.length <= 5, `re-packed to the local node cap (got ${context.nodes.length})`);
    assert.ok(context.metrics.tokensInjected <= 1500);
    assert.equal(lines.at(-1).type, 'done');

    const [request] = fake.state.chatRequests;
    assert.equal(request.messages[0].content, SYSTEM_PROMPTS.strict_xml, 'local prompt structure after the re-pack');
    const row = await metricsRow(context.queryId);
    assert.equal(row.routing_reason, 'privacy_flag');
    assert.equal(row.tier, 'local_7b');
  });

  test('a cloud request with public-only context is refused explicitly, not answered locally', async () => {
    const before = await accessCount(ids.quantify);
    const { status, data } = await api('POST', '/api/chat', {
      query: 'what does quantify_colonies return in the mask',
      tier: 'cloud_frontier',
    });
    assert.equal(status, 503);
    assert.equal(data.code, 'cloud_unavailable');
    assert.equal(data.routing.reason, 'user_override');
    assert.match(data.error, /API key/);
    assert.equal(fake.state.chatRequests.length, 0);

    const row = await metricsRow(data.queryId);
    assert.equal(row.routing_decision, 'cloud');
    assert.equal(row.routing_reason, 'user_override');
    assert.equal(row.model_used, null);
    assert.equal(await accessCount(ids.quantify), before, 'a refused query did not use its nodes');
  });

  test('with Ollama down, retrieval runs lexical-only and routes cloud for no_ollama', async () => {
    process.env.OLLAMA_URL = await deadUrl();
    const { status, data } = await api('POST', '/api/chat', { query: 'quantify_colonies colony count watershed' });
    assert.equal(status, 503);
    assert.equal(data.code, 'cloud_unavailable');
    assert.equal(data.routing.reason, 'no_ollama');
    assert.equal(data.routing.provisionalTier, 'cloud_frontier');
    assert.ok(data.nodes.some((node) => node.id === ids.quantify), 'the lexical channel still found the node');

    const row = await metricsRow(data.queryId);
    assert.equal(row.routing_reason, 'no_ollama');
    assert.equal(row.embedding_latency_ms, null, 'no embedding was attempted');
  });

  test('with Ollama down, private context is refused rather than sent anywhere', async () => {
    process.env.OLLAMA_URL = await deadUrl();
    const { status, data } = await privateApi('POST', '/api/chat', { query: 'stepper calibrate limit switch offset flash' });
    assert.equal(status, 503);
    assert.equal(data.code, 'local_unavailable');
    assert.equal(data.routing.reason, 'privacy_flag');
    assert.match(data.error, /private context/);
    assert.ok(data.nodes.every((node) => node.project === 'hmb/stage-firmware'));
  });

  test('Ollama running without the chat model counts as no local model', async () => {
    fake.state.models = ['nomic-embed-text:latest'];
    const { status, data } = await api('POST', '/api/chat', { query: 'quantify_colonies mean area result' });
    assert.equal(status, 503);
    assert.equal(data.routing.reason, 'no_ollama');
    assert.match(data.error, new RegExp(`ollama pull ${localChatModel().replace('.', '\\.')}`));
  });

  test('a model error mid-stream ends the stream with an error line', async () => {
    fake.state.failAfterFirst = 'model runner crashed';
    const lines = await readLines(await chat({ query: 'quantify_colonies label mask output' }));
    assert.deepEqual(lines.map((line) => line.type), ['context', 'token', 'error']);
    assert.match(lines.at(-1).error, /model runner crashed/);
    assert.equal(lines.at(-1).queryId, lines[0].queryId);
    const row = await metricsRow(lines[0].queryId);
    assert.equal(row.output_tokens, null);
  });

  test('a client disconnect aborts generation upstream and still logs the query', async () => {
    fake.state.pauseAfterFirstMs = 2000;
    const controller = new AbortController();
    const response = await chat({ query: 'quantify_colonies returns what exactly' }, { signal: controller.signal });
    let queryId;
    try {
      for await (const line of parseNdjson(response.body)) {
        if (line.type === 'context') queryId = line.queryId;
        if (line.type === 'token') controller.abort();
      }
    } catch (err) {
      assert.equal(err.name, 'AbortError');
    }
    for (let i = 0; i < 50 && fake.state.aborted === 0; i++) await sleep(20);
    assert.equal(fake.state.aborted, 1, 'the upstream model request was cancelled');
    const row = await metricsRow(queryId);
    assert.ok(row.ttft_ms !== null);
    assert.equal(row.output_tokens, null, 'the model never reported a final count');
  });

  test('validation and authentication', async () => {
    assert.equal((await api('POST', '/api/chat', {})).status, 400);
    assert.equal((await api('POST', '/api/chat', { query: 'x', tier: 'huge' })).status, 400);
    assert.equal((await session(server.base)('POST', '/api/chat', { query: 'x' })).status, 401);
  });
});
