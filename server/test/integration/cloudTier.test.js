import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { costUsd, priceFor, webCitations } from '../../src/lib/anthropic.js';
import { parseNdjson } from '../../src/lib/ollama.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeAnthropic } from '../fakeAnthropic.js';
import { doneEvent, linkUser, meFor, startFakeControl } from '../fakeControl.js';
import { deadUrl, startFakeOllama } from '../fakeOllama.js';
import { ensureCentroids, registeredSession, startServer } from '../helpers.js';

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
const KEY = 'sk-ant-test-not-a-real-key';

describe('cloud tier', () => {
  let server;
  let ollama;
  let anthropic;
  let control;
  let api;
  let ids;

  const chat = (body, headers = {}) =>
    api.raw('POST', '/api/chat', body, { headers: { 'Content-Type': 'application/json', ...headers } });

  async function readLines(response) {
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  }

  // The plan comes from the control plane: a signed-in link with its /v1/me
  // answer cached, registered with the stand-in control plane under the same
  // token so a platform answer is accepted.
  async function setPlan(session, plan, me = meFor(plan)) {
    const id = (await session('GET', '/api/auth/session')).data.userId;
    const token = await linkUser(server.pool, id, plan, { me });
    control.state.me.set(token, me);
    return id;
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
    control = await startFakeControl();
    process.env.OLLAMA_URL = ollama.url;
    process.env.CONTROL_URL = control.url;
    process.env.ANTHROPIC_BASE_URL = anthropic.url;
    server = await startServer();
    await ensureCentroids(server.pool);
    api = await registeredSession(server.base);
    // Choosing the cloud is Key Pro only; the plan-rule tests below use their own users.
    await setPlan(api, 'key_pro');

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
    Object.assign(anthropic.state, {
      requests: [], authHeaders: [], text: ['Cloud ', 'answer.'], status: 200, outputTokens: 40,
      search: null, pauseAfterSearch: false,
    });
    Object.assign(ollama.state, { chatRequests: [], tokens: ['Local ', 'answer.'], pauseAfterFirstMs: 0, failAfterFirst: null });
    control.state.requests = [];
    control.state.cloud = [];
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CONTROL_URL;
    await server.close();
    await control.close();
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
    assert.equal(done.searches, undefined, 'no web search, no searches list');
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
    assert.equal(row.web_searches, null, 'an answer without web search records no search count');
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

  describe('web search', () => {
    const search = { query: 'railway pgvector setup', url: 'https://example.com/pgvector', title: 'pgvector on Railway' };

    test('searches on the cloud tier, streams what it searched, cites the pages, and bills the search', async () => {
      anthropic.state.search = search;
      const response = await chat(
        { query: 'how does the ingestion pipeline chunk and prune files', webSearch: true },
        { 'x-anthropic-api-key': KEY }
      );
      assert.equal(response.status, 200);
      const lines = await readLines(response);

      assert.equal(lines[0].routing.decision, 'cloud', 'web search makes it a cloud answer without choosing a tier');
      const [request] = anthropic.state.requests;
      assert.deepEqual(request.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);

      assert.deepEqual(lines.filter((l) => l.type === 'searching').map((l) => l.query), [search.query]);
      const done = lines.at(-1);
      assert.equal(done.type, 'done');
      assert.deepEqual(done.web, [{ url: search.url, title: search.title }]);
      assert.deepEqual(done.searches, [search.query], 'the queries it searched come back with the answer');
      assert.equal((await metricsRow(done.queryId)).web_searches, 1, 'and the count is recorded');

      const withoutSearch = costUsd('claude-sonnet-5', { input_tokens: 1200, output_tokens: 40 });
      assert.ok(Math.abs(done.metrics.costUsd - withoutSearch - 0.01) < 1e-9, 'one search adds a cent');
    });

    test('a paused search turn is resumed and finishes as one answer', async () => {
      Object.assign(anthropic.state, { search, pauseAfterSearch: true });
      const lines = await readLines(
        await chat({ query: 'how does the ingestion pipeline chunk files', webSearch: true }, { 'x-anthropic-api-key': KEY })
      );
      assert.equal(anthropic.state.requests.length, 2, 'the paused turn was sent back once');
      const resumed = anthropic.state.requests[1].messages.at(-1);
      assert.equal(resumed.role, 'assistant');
      assert.ok(resumed.content.some((block) => block.type === 'server_tool_use'), 'sent back exactly as it stood');
      assert.equal(lines.filter((l) => l.type === 'token').map((l) => l.text).join(''), 'Cloud answer.');
      assert.deepEqual(lines.at(-1).web, [{ url: search.url, title: search.title }]);
      const done = lines.at(-1);
      assert.equal(done.metrics.promptTokens, 2400, 'usage from both requests is counted');
    });

    test('nodes marked private are left out of a web answer, which says how many it skipped', async () => {
      anthropic.state.search = search;
      const response = await chat(
        { query: 'stepper calibration constants for the unreleased stage secret motor', webSearch: true },
        { 'x-anthropic-api-key': KEY }
      );
      assert.equal(response.status, 200, 'answered, not refused');
      const lines = await readLines(response);
      const [context] = lines;
      assert.equal(context.routing.decision, 'cloud');
      assert.ok(context.nodes.every((node) => node.privacy !== 'local'), 'no private node in context');
      assert.ok(!context.nodes.some((node) => node.id === ids.secret));
      assert.ok(context.omittedPrivate >= 1, 'the private node it would have read is counted');

      // The question itself goes out, as every cloud question does; the private
      // file must not, neither by path nor inside the context block.
      const sent = JSON.stringify(anthropic.state.requests);
      assert.ok(!sent.includes('firmware/secret_motor.c'), 'the private file never reached Anthropic');
      const first = anthropic.state.requests[0].messages[0].content;
      const text = typeof first === 'string' ? first : first.map((block) => block.text).join('');
      const contextPart = text.split('## Question')[0];
      assert.match(contextPart, /## Context/, 'there is a context section to inspect');
      assert.ok(!/stepper calibration constants/.test(contextPart), 'nor its contents, in the context');
      assert.equal(lines.at(-1).type, 'done');
    });

    test('a web answer with nothing private to skip reports zero', async () => {
      anthropic.state.search = search;
      const [context] = await readLines(
        await chat({ query: 'how does the ingestion pipeline chunk files', webSearch: true }, { 'x-anthropic-api-key': KEY })
      );
      assert.equal(context.omittedPrivate, 0);
    });

    test('without web search, private context still forces the local tier as before', async () => {
      const response = await chat(
        { query: 'stepper calibration constants for the unreleased stage secret motor', tier: 'cloud_frontier' },
        { 'x-anthropic-api-key': KEY }
      );
      const [context] = await readLines(response);
      assert.equal(context.routing.decision, 'local');
      assert.equal(context.routing.reason, 'privacy_flag');
      assert.equal(anthropic.state.requests.length, 0);
    });

    test('without a key it says web search needs one', async () => {
      const response = await chat({ query: 'how does the ingestion pipeline chunk files', webSearch: true });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /Web search runs on the cloud tier/);
    });

    test('webSearch must be a boolean', async () => {
      assert.equal((await chat({ query: 'x', webSearch: 'yes' })).status, 400);
    });

    test('citations are deduplicated by URL and ignore non-web citations', () => {
      const citation = (url, title) => ({ type: 'web_search_result_location', url, title, cited_text: '', encrypted_index: '' });
      const cited = webCitations([
        { type: 'text', text: 'a', citations: [citation('https://a', 'A'), citation('https://b', null)] },
        { type: 'text', text: 'b', citations: [citation('https://a', 'A'), { type: 'char_location', cited_text: '' }] },
        { type: 'server_tool_use', name: 'web_search', input: {} },
      ]);
      assert.deepEqual(cited, [{ url: 'https://a', title: 'A' }, { url: 'https://b', title: 'https://b' }]);
    });
  });

  describe('plan rules', () => {
    const question = 'how does the ingestion pipeline chunk and prune files';
    const as = (session) => (body, headers = {}) =>
      session.raw('POST', '/api/chat', body, { headers: { 'Content-Type': 'application/json', ...headers } });
    const cloudCalls = () => control.cloudRequests();

    async function userOn(plan, me) {
      const session = await registeredSession(server.base);
      const id = await setPlan(session, plan, me);
      await session('POST', '/api/nodes', {
        type: 'file',
        content: 'docs/pipeline.md\n\nThe ingestion pipeline chunks files, embeds each chunk, and prunes deleted paths.',
        project: 'hmb/docs',
        privacy: 'cloud',
      });
      return { session, id, chat: as(session) };
    }

    async function withLocalDown(fn) {
      const previous = process.env.OLLAMA_URL;
      process.env.OLLAMA_URL = await deadUrl();
      try {
        return await fn();
      } finally {
        process.env.OLLAMA_URL = previous;
      }
    }

    test('choosing Cloud or web search off Key Pro is refused, even with a valid key, and nothing leaves the machine', async () => {
      for (const plan of ['free', 'student', 'engineer']) {
        const { chat: ask } = await userOn(plan);
        for (const body of [{ query: question, tier: 'cloud_frontier' }, { query: question, webSearch: true }]) {
          const response = await ask(body, { 'x-anthropic-api-key': KEY });
          assert.equal(response.status, 403, `${plan} ${JSON.stringify(body)}`);
          const payload = await response.json();
          assert.equal(payload.code, 'cloud_requires_key_pro');
          assert.match(payload.error, /Key Pro/);
          // Free is never told Auto will reach the cloud, because it will not.
          assert.equal(/uses the cloud on its own/.test(payload.error), plan !== 'free', plan);
        }
      }
      assert.equal(anthropic.state.requests.length, 0);
      assert.equal(cloudCalls().length, 0);
    });

    test('Student on Auto answers locally while the local model can, and the platform is not asked', async () => {
      const { chat: ask } = await userOn('student');
      const lines = await readLines(await ask({ query: question }));
      assert.equal(lines[0].routing.decision, 'local');
      assert.equal(cloudCalls().length, 0);
    });

    test('Student on Auto reaches the cloud through the control plane when the local model is down, billed to the platform', async () => {
      const { chat: ask, id } = await userOn('student');
      const token = [...control.state.me.keys()].at(-1);
      const lines = await withLocalDown(async () => readLines(await ask({ query: question }, { 'x-anthropic-api-key': KEY })));
      const [context] = lines;
      assert.equal(context.routing.decision, 'cloud');
      assert.equal(context.routing.reason, 'no_ollama');
      assert.equal(context.routing.model, 'anthropic/claude-sonnet-5');
      assert.equal(lines.filter((line) => line.type === 'token').map((line) => line.text).join(''), 'Platform answer.');
      assert.equal(lines.at(-1).type, 'done');
      assert.equal(lines.at(-1).metrics.costUsd, 0.0042, "the control plane's price");

      assert.equal(anthropic.state.requests.length, 0, 'the engine never calls Anthropic for a platform answer');
      const [call] = cloudCalls();
      assert.equal(call.auth, `Bearer ${token}`, "this user's device token, never the user's own key");
      assert.deepEqual(Object.keys(call.body).sort(), ['cacheMarker', 'hard', 'messages', 'requestId', 'sources']);
      assert.equal(call.body.hard, false);
      assert.equal(call.body.cacheMarker, '## Question');
      assert.deepEqual(call.body.sources, ['manual'], 'the plug-ins behind the packed nodes');
      assert.ok(call.body.messages.some((m) => m.role === 'user' && /ingestion pipeline/.test(JSON.stringify(m.content))));

      const row = await metricsRow(lines.at(-1).queryId);
      assert.equal(row.billed_to, 'platform');
      assert.equal(Number(row.cost_usd), 0.0042);
      assert.equal(row.model_used, 'anthropic/claude-sonnet-5');
      assert.ok(id);
    });

    test('the model recorded is the one the control plane answered with, which can differ from the one it predicted', async () => {
      const { chat: ask } = await userOn('engineer');
      control.state.cloud.push({ events: [{ text: 'Stepped down.' }, doneEvent({ model: 'claude-sonnet-5', economy: true })] });
      const lines = await readLines(await ask({ query: hardQuestion }));
      assert.equal(lines[0].routing.model, 'anthropic/claude-opus-5', 'what /v1/me said the next hard answer would use');
      assert.equal((await metricsRow(lines.at(-1).queryId)).model_used, 'anthropic/claude-sonnet-5');
    });

    test('a spent allowance or a used-up month, as the control plane last reported them, stops the cloud without asking it', async () => {
      const spent = meFor('student', { limits: { weeklySpentUsd: 2, weeklyAllowanceUsd: 1.03 } });
      const { chat: weekly } = await userOn('student', spent);
      const response = await withLocalDown(() => weekly({ query: question }));
      assert.equal(response.status, 503);
      const payload = await response.json();
      assert.equal(payload.code, 'allowance_exhausted');
      assert.match(payload.error, /allowance is used/);

      const { chat: monthly } = await userOn('student', meFor('student', { limits: { answersUsed: 200 } }));
      const limited = await withLocalDown(() => monthly({ query: question }));
      assert.equal(limited.status, 503);
      const limitPayload = await limited.json();
      assert.equal(limitPayload.code, 'answer_limit_reached');
      assert.match(limitPayload.error, /cloud answers are used/);
      assert.equal(cloudCalls().length, 0);
    });

    test('an allowance spent since the plan was cached is refused by the control plane, answered as before, and the cache is expired', async () => {
      const { chat: ask, id } = await userOn('student');
      control.state.cloud.push({
        status: 402,
        body: { error: "This week's cloud allowance is used up.", code: 'allowance_exhausted', freesUpNext: { amountUsd: 0.04, at: '2026-10-28T09:00:00Z' } },
      });
      const response = await withLocalDown(() => ask({ query: question }));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'allowance_exhausted');
      assert.equal(cloudCalls().length, 1, 'a refusal on allowance grounds is not retried');
      const { rows: [link] } = await server.pool.query('SELECT me_fetched_at FROM control_links WHERE owner_id = $1', [id]);
      assert.equal(link.me_fetched_at, null, 'the next request asks the control plane again');
    });

    test('when the control plane refuses and the local model is up, the question is answered locally', async () => {
      const { chat: ask } = await userOn('engineer');
      control.state.cloud.push({ status: 503, body: { error: 'Scope Studio cloud is unavailable right now.', code: 'platform_cloud_unavailable' } });
      const lines = await readLines(await ask({ query: hardQuestion }));
      assert.equal(lines[0].routing.decision, 'local');
      assert.match(lines[0].routing.model, /^ollama\//);
      assert.equal(lines.at(-1).type, 'done');
      assert.equal(cloudCalls().length, 1, 'a configuration refusal is not retried');
      assert.equal(ollama.state.chatRequests.length, 1);
    });

    test('with the control plane unreachable, a platform plan answers locally and never shows an error', async () => {
      const { chat: ask } = await userOn('engineer');
      const saved = process.env.CONTROL_URL;
      process.env.CONTROL_URL = await deadUrl();
      try {
        const lines = await readLines(await ask({ query: hardQuestion }));
        assert.equal(lines[0].routing.decision, 'local');
        assert.equal(lines.at(-1).type, 'done');
      } finally {
        process.env.CONTROL_URL = saved;
      }
    });

    test('with the local model down and the control plane refusing for another reason, the local message is shown', async () => {
      const { chat: ask } = await userOn('student');
      control.state.cloud.push({ status: 403, body: { error: 'Cloud answers paid by Scope Studio are part of the Student and Engineer plans.', code: 'cloud_not_in_plan' } });
      const response = await withLocalDown(() => ask({ query: question }, { 'x-anthropic-api-key': KEY }));
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /local model is not available/);
      assert.equal(anthropic.state.requests.length, 0, 'the user key was not used either');
    });

    test('an answer that fails before its first word is retried once on a fresh requestId', async () => {
      const { chat: ask } = await userOn('student');
      control.state.cloud.push({ events: [{ error: 'The cloud model returned an error (529). Try again shortly.', code: 'upstream_error' }] });
      const lines = await withLocalDown(async () => readLines(await ask({ query: question })));
      assert.equal(lines.at(-1).type, 'done');
      assert.equal(lines.filter((line) => line.type === 'token').map((line) => line.text).join(''), 'Platform answer.');
      const ids = cloudCalls().map((call) => call.body.requestId);
      assert.equal(ids.length, 2);
      assert.notEqual(ids[0], ids[1]);
    });

    test('an answer that fails after text arrived ends with an error line, not a repeated answer', async () => {
      const { chat: ask } = await userOn('student');
      control.state.cloud.push({ events: [{ text: 'Half an ' }, { error: 'The cloud answer stopped partway through. Try again shortly.', code: 'upstream_error' }] });
      const lines = await withLocalDown(async () => readLines(await ask({ query: question })));
      assert.equal(lines.at(-1).type, 'error');
      assert.match(lines.at(-1).error, /stopped partway/);
      assert.equal(cloudCalls().length, 1);
    });

    const hardQuestion = 'compare how the ingestion pipeline chunks and prunes files against the alternatives';

    test('Engineer on Auto sends a hard question to the platform as hard while the local model is up, and shows Opus', async () => {
      const { chat: ask } = await userOn('engineer');
      const lines = await readLines(await ask({ query: hardQuestion }));
      const [context] = lines;
      assert.equal(context.routing.decision, 'cloud');
      assert.equal(context.routing.reason, 'complexity');
      assert.equal(context.routing.difficulty, 'wording');
      assert.equal(context.routing.model, 'anthropic/claude-opus-5');
      assert.equal(cloudCalls()[0].body.hard, true);
      assert.equal((await metricsRow(lines.at(-1).queryId)).billed_to, 'platform');
    });

    test('Engineer on Auto keeps an easy question local, and the platform is not asked', async () => {
      const { chat: ask } = await userOn('engineer');
      const [context] = await readLines(await ask({ query: question }));
      assert.equal(context.routing.decision, 'local');
      assert.equal(cloudCalls().length, 0);
    });

    test('Student on Auto sends a hard question on Sonnet, not Opus, even if it asks for Opus, and never names a model', async () => {
      const { chat: ask } = await userOn('student');
      const [context] = await readLines(await ask({ query: hardQuestion, cloudModel: 'claude-opus-5' }));
      assert.equal(context.routing.reason, 'complexity');
      assert.equal(context.routing.model, 'anthropic/claude-sonnet-5');
      assert.equal(cloudCalls()[0].body.model, undefined, 'the control plane picks the model');
    });

    test("Key Pro may choose Opus on its own key, and Auto sends its hard questions there too", async () => {
      const { chat: ask } = await userOn('key_pro');
      const [chosen] = await readLines(await ask({ query: question, tier: 'cloud_frontier', cloudModel: 'claude-opus-5' }, { 'x-anthropic-api-key': KEY }));
      assert.equal(chosen.routing.model, 'anthropic/claude-opus-5');
      const [auto] = await readLines(await ask({ query: hardQuestion }, { 'x-anthropic-api-key': KEY }));
      assert.equal(auto.routing.reason, 'complexity');
      assert.ok(anthropic.state.authHeaders.every((header) => header === KEY), "only the user's own key");
      assert.equal(cloudCalls().length, 0, 'Key Pro never goes through the platform');
    });

    test('Free on Auto keeps a hard question local', async () => {
      const { chat: ask } = await userOn('free');
      const [context] = await readLines(await ask({ query: hardQuestion }, { 'x-anthropic-api-key': KEY }));
      assert.equal(context.routing.decision, 'local');
      assert.equal(anthropic.state.requests.length, 0);
      assert.equal(cloudCalls().length, 0);
    });

    test('Key Pro may choose Haiku, and gets no effort setting, which Haiku refuses', async () => {
      const { chat: ask } = await userOn('key_pro');
      const lines = await readLines(await ask({ query: question, tier: 'cloud_frontier', cloudModel: 'claude-haiku-4-5' }, { 'x-anthropic-api-key': KEY }));
      assert.equal(lines[0].routing.model, 'anthropic/claude-haiku-4-5');
      assert.equal(lines.at(-1).type, 'done');
      assert.equal(anthropic.state.requests.at(-1).output_config, undefined);
    });

    test('an unoffered model choice is refused', async () => {
      const { chat: ask } = await userOn('key_pro');
      assert.equal((await ask({ query: question, cloudModel: 'claude-fable-5-1' })).status, 400);
    });

    test('Free on Auto with the local model down never reaches the cloud', async () => {
      const { chat: ask } = await userOn('free');
      const response = await withLocalDown(() => ask({ query: question }, { 'x-anthropic-api-key': KEY }));
      assert.equal(response.status, 503);
      assert.equal(anthropic.state.requests.length, 0);
      assert.equal(cloudCalls().length, 0);
    });

    test('a Student or Engineer whose sign-in is gone runs as Free: local only', async () => {
      const { chat: ask, id } = await userOn('engineer');
      await server.pool.query('DELETE FROM control_links WHERE owner_id = $1', [id]);
      const [context] = await readLines(await ask({ query: hardQuestion }));
      assert.equal(context.routing.decision, 'local');
      assert.equal(cloudCalls().length, 0);
    });
  });
});
