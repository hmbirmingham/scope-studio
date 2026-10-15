import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { hashToken, newDeviceToken } from '../../src/auth/tokens.js';
import { ECONOMY_MAX_TOKENS, monthlyAnswerLimit, weeklyAllowanceUsd } from '../../src/billing/plans.js';
import { BREVITY_NOTE, costUsd, MAX_TOKENS } from '../../src/lib/anthropic.js';
import { recordUsage } from '../../src/models/ledger.js';
import { MAX_STREAMS_PER_ACCOUNT } from '../../src/routes/cloud.js';
import { startFakeAnthropic } from '../fakeAnthropic.js';
import { createAccount, startServer, truncateAll } from '../helpers.js';

// Obviously fake: the client never leaves localhost (ANTHROPIC_BASE_URL is the stand-in).
const FAKE_PLATFORM_KEY = 'sk-ant-test-not-a-real-key';
// Distinctive strings that must never show up in a log line or the ledger.
const SECRET_CONTEXT = 'PRIVATE-CONTEXT-c0ffee-stepper-calibration';
const SECRET_QUESTION = 'what does PRIVATE-QUESTION-5eed do';

let server;
let anthropic;
let accounts = 0;
let requests = 0;

before(async () => {
  anthropic = await startFakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = anthropic.url;
  server = await startServer();
});
beforeEach(async () => {
  await truncateAll(server.pool);
  anthropic.reset();
  process.env.PLATFORM_ANTHROPIC_API_KEY = FAKE_PLATFORM_KEY;
});
after(async () => {
  await anthropic.close();
  await server.close();
  delete process.env.PLATFORM_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
});

// A signed-in device on a new account with the given plan.
async function signIn(plan) {
  accounts += 1;
  const account = await createAccount(server.pool, { email: `cloud${accounts}@scope.local`, plan });
  const token = newDeviceToken();
  await server.pool.query(
    `INSERT INTO device_tokens (account_id, token_hash, label) VALUES ($1, $2, 'test device')`,
    [account.id, hashToken(token)]
  );
  return { id: account.id, token };
}

function question(overrides = {}) {
  requests += 1;
  return {
    requestId: `request-${requests}-0000`,
    messages: [
      { role: 'system', content: 'Answer from the context.' },
      { role: 'user', content: `<context>${SECRET_CONTEXT}</context>\n<question>${SECRET_QUESTION}</question>` },
    ],
    cacheMarker: '<question>',
    hard: false,
    sources: ['github'],
    ...overrides,
  };
}

function ask(device, body, { signal, token = device?.token } = {}) {
  return fetch(`${server.base}/v1/cloud/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
}

function parseEvents(text) {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

async function events(response) {
  return parseEvents(await response.text());
}

// Opens a stream and reads until the first text event, leaving it open.
async function openStream(device, body) {
  const controller = new AbortController();
  const response = await ask(device, body, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('"text"')) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  return { controller, received, hangUp: () => controller.abort() };
}

async function ledgerRow(requestId) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await server.pool.query('SELECT * FROM usage_ledger WHERE request_id = $1', [requestId]);
    if (rows[0]) return rows[0];
    await sleep(20);
  }
  throw new Error(`no ledger row for ${requestId}`);
}

async function until(condition, what) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// cost_usd is stored to six places; rounding up keeps a seeded spend at or
// past the threshold it is meant to reach.
const atLeast = (usd) => Math.ceil(usd * 1e6) / 1e6;

async function spend(accountId, usd, requestId = `seed-${accountId}`) {
  await recordUsage({ accountId, requestId, model: 'claude-sonnet-5', costUsd: atLeast(usd) }, server.pool);
}

// Completed answers that cost nothing, so they count against the month and
// not the week.
async function answered(accountId, count) {
  await server.pool.query(
    `INSERT INTO usage_ledger (account_id, request_id, model, cost_usd)
     SELECT $1::uuid, 'bulk-' || $1 || '-' || g, 'claude-sonnet-5', 0 FROM generate_series(1, $2::int) g`,
    [accountId, count]
  );
}

describe('a platform-paid answer', () => {
  test('streams text then a done event, and charges the ledger once with its sources', async () => {
    Object.assign(anthropic.state, { cacheCreationTokens: 3000, cacheReadTokens: 500 });
    const device = await signIn('student');
    const body = question({ sources: ['github', 'local_folder', 'github'] });
    const response = await ask(device, body);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const received = await events(response);
    assert.deepEqual(received.slice(0, -1), [{ text: 'Cloud ' }, { text: 'answer.' }]);

    const usage = { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 3000, cache_read_input_tokens: 500 };
    const done = received.at(-1);
    assert.deepEqual(Object.keys(done).sort(), ['costUsd', 'done', 'economy', 'model', 'stopReason', 'usage']);
    assert.equal(done.done, true);
    assert.deepEqual(done.usage, usage);
    assert.equal(done.stopReason, 'end_turn');
    assert.equal(done.model, 'claude-sonnet-5');
    assert.equal(done.economy, false);
    assert.ok(Math.abs(done.costUsd - costUsd('claude-sonnet-5', usage)) < 1e-12);

    // What went upstream: the plan's model, effort and ceiling, on the platform key.
    assert.equal(anthropic.state.requests.length, 1);
    const sent = anthropic.state.requests[0];
    assert.equal(anthropic.state.authHeaders[0], FAKE_PLATFORM_KEY);
    assert.equal(sent.model, 'claude-sonnet-5');
    assert.equal(sent.max_tokens, MAX_TOKENS);
    assert.deepEqual(sent.output_config, { effort: 'medium' });
    assert.equal(sent.tools, undefined);
    assert.equal(sent.system, 'Answer from the context.');
    assert.deepEqual(sent.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.ok(sent.messages[0].content[1].text.startsWith('<question>'));

    const row = await ledgerRow(body.requestId);
    assert.equal(row.account_id, device.id);
    assert.equal(row.model, 'claude-sonnet-5');
    assert.equal(row.hard, false);
    assert.equal(row.input_tokens, 1200 + 3000 + 500);
    assert.equal(row.output_tokens, 40);
    assert.equal(Number(row.cost_usd), Number(done.costUsd.toFixed(6)));
    assert.deepEqual(row.sources, ['github', 'local_folder']);
    const { rows } = await server.pool.query('SELECT count(*)::int AS n FROM usage_ledger');
    assert.equal(rows[0].n, 1);
  });

  test("Engineer's hard questions go to Opus until half the week's allowance is spent, then to a shorter Sonnet", async () => {
    const device = await signIn('engineer');
    let received = await events(await ask(device, question({ hard: true })));
    assert.equal(received.at(-1).model, 'claude-opus-5');
    assert.equal(anthropic.state.requests[0].model, 'claude-opus-5');
    assert.equal(anthropic.state.requests[0].max_tokens, MAX_TOKENS);

    // Clear the real answer's spend so the seeded one alone sets the level.
    await server.pool.query('DELETE FROM usage_ledger');
    await spend(device.id, weeklyAllowanceUsd('engineer') * 0.5);
    received = await events(await ask(device, question({ hard: true })));
    const done = received.at(-1);
    assert.equal(done.model, 'claude-sonnet-5');
    assert.equal(done.economy, true);
    const sent = anthropic.state.requests[1];
    assert.equal(sent.model, 'claude-sonnet-5');
    assert.equal(sent.max_tokens, ECONOMY_MAX_TOKENS);
    assert.ok(sent.messages.at(-1).content.at(-1).text.endsWith(BREVITY_NOTE));
  });

  test('Student stays on Sonnet past half the allowance, with the economy ceiling', async () => {
    const device = await signIn('student');
    await spend(device.id, weeklyAllowanceUsd('student') * 0.5);
    const body = question({ hard: true });
    const done = (await events(await ask(device, body))).at(-1);
    assert.equal(done.model, 'claude-sonnet-5');
    assert.equal(done.economy, true);
    assert.equal(anthropic.state.requests[0].max_tokens, ECONOMY_MAX_TOKENS);
    assert.equal((await ledgerRow(body.requestId)).hard, true);
  });

  test('a failure after streaming began ends with an upstream_error event that quotes nothing, and is still charged', async () => {
    anthropic.state.failMidStream = true;
    const device = await signIn('student');
    const body = question();
    const response = await ask(device, body);
    assert.equal(response.status, 200);
    const received = await events(response);
    assert.deepEqual(received.slice(0, 2), [{ text: 'Cloud ' }, { text: 'answer.' }]);
    const last = received.at(-1);
    assert.deepEqual(Object.keys(last).sort(), ['code', 'error']);
    assert.equal(last.code, 'upstream_error');
    assert.doesNotMatch(last.error, /Overloaded|PRIVATE|context/);
    assert.ok(!received.some((event) => event.done));

    const row = await ledgerRow(body.requestId);
    assert.equal(row.input_tokens, 1200);
    assert.ok(row.output_tokens >= 1);
    assert.ok(Number(row.cost_usd) > 0);
    assert.equal(row.completed, false);
  });

  test("an answer that fails upstream is charged but does not use up one of the month's answers", async () => {
    const device = await signIn('student');
    await answered(device.id, monthlyAnswerLimit('student') - 1);

    anthropic.state.failMidStream = true;
    const failed = question();
    const last = (await events(await ask(device, failed))).at(-1);
    assert.equal(last.code, 'upstream_error');
    const row = await ledgerRow(failed.requestId);
    assert.equal(row.completed, false);
    assert.ok(Number(row.cost_usd) > 0, 'the platform still paid for it');

    // The month's last answer is still there to use, and using it ends the month.
    anthropic.state.failMidStream = false;
    const answer = question();
    const response = await ask(device, answer);
    assert.equal(response.status, 200);
    assert.equal((await events(response)).at(-1).done, true);
    assert.equal((await ledgerRow(answer.requestId)).completed, true);
    const after = await ask(device, question());
    assert.equal(after.status, 402);
    assert.equal((await after.json()).code, 'answer_limit_reached');
  });
});

describe('refusals happen before any upstream call', () => {
  async function refused(response, status, code) {
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(typeof body.error, 'string');
    assert.equal(anthropic.state.requests.length, 0, 'nothing reached the model');
    return body;
  }

  test('no device token is a 401', async () => {
    await refused(await ask(null, question()), 401, 'unauthenticated');
  });

  test('Free and Key Pro are not paid for by the platform', async () => {
    await refused(await ask(await signIn('free'), question()), 403, 'cloud_not_in_plan');
    await refused(await ask(await signIn('key_pro'), question()), 403, 'cloud_not_in_plan');
    // The plan is checked before the key: a Free account learns about its plan.
    delete process.env.PLATFORM_ANTHROPIC_API_KEY;
    await refused(await ask(await signIn('free'), question()), 403, 'cloud_not_in_plan');
  });

  test('without a platform key there is no platform cloud, never a fallback', async () => {
    delete process.env.PLATFORM_ANTHROPIC_API_KEY;
    const device = await signIn('engineer');
    await refused(await ask(device, question()), 503, 'platform_cloud_unavailable');
    // Checked before the ledger: a recorded request id still gets the 503.
    await recordUsage({ accountId: device.id, requestId: 'already-recorded', model: 'claude-sonnet-5', costUsd: 0.01 }, server.pool);
    await refused(await ask(device, question({ requestId: 'already-recorded' })), 503, 'platform_cloud_unavailable');
  });

  test('a request id already in the ledger is a 409, and is not charged again', async () => {
    const device = await signIn('student');
    const body = question();
    await events(await ask(device, body));
    assert.equal(anthropic.state.requests.length, 1);
    anthropic.reset();
    await refused(await ask(device, body), 409, 'duplicate_request');
    const { rows } = await server.pool.query('SELECT count(*)::int AS n FROM usage_ledger');
    assert.equal(rows[0].n, 1);
  });

  test("a month's answers used up is a 402 that says when the next one frees up", async () => {
    const device = await signIn('student');
    await server.pool.query(
      `INSERT INTO usage_ledger (account_id, request_id, model, cost_usd)
       SELECT $1, 'bulk-' || g, 'claude-sonnet-5', 0 FROM generate_series(1, 200) g`,
      [device.id]
    );
    const body = await refused(await ask(device, question()), 402, 'answer_limit_reached');
    assert.equal(body.freesUpNext.answers, 1);
    assert.ok(new Date(body.freesUpNext.at) > new Date());
  });

  test("a week's allowance spent is a 402 with the next spend to free up", async () => {
    const device = await signIn('engineer');
    await spend(device.id, weeklyAllowanceUsd('engineer'));
    const body = await refused(await ask(device, question()), 402, 'allowance_exhausted');
    assert.equal(body.freesUpNext.amountUsd, atLeast(weeklyAllowanceUsd('engineer')));
    assert.ok(new Date(body.freesUpNext.at) > new Date());
  });

  test('model, max_tokens, effort, tools and web search are decided here and cannot be sent', async () => {
    const device = await signIn('engineer');
    const attempts = [
      { model: 'claude-opus-5' }, { max_tokens: 8000 }, { maxTokens: 8000 }, { effort: 'high' },
      { output_config: { effort: 'high' } }, { tools: [{ type: 'web_search_20260209', name: 'web_search' }] },
      { webSearch: true }, { web_search: true }, { tool_choice: { type: 'any' } }, { anything: 1 },
    ];
    for (const attempt of attempts) {
      await refused(await ask(device, question(attempt)), 400, 'field_not_allowed');
    }
  });

  test('content blocks may carry only their own keys: caching breakpoints, citations and tool blocks are refused', async () => {
    const device = await signIn('engineer');
    const blocks = [
      { type: 'text', text: SECRET_CONTEXT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: SECRET_CONTEXT, citations: [] },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' }, cache_control: { type: 'ephemeral' } },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: SECRET_CONTEXT } },
      { type: 'tool_use', id: 't', name: 'x', input: {} },
      { type: 'tool_result', tool_use_id: 't', content: SECRET_CONTEXT },
    ];
    for (const block of blocks) {
      const messages = [{ role: 'user', content: [block, { type: 'text', text: SECRET_QUESTION }] }];
      const body = await refused(await ask(device, question({ messages })), 400, 'field_not_allowed');
      assert.doesNotMatch(body.error, /PRIVATE/);
    }
  });

  test('sources must be at most sixteen plug-in names', async () => {
    const device = await signIn('engineer');
    const tooMany = Array.from({ length: 17 }, (_, i) => `plugin_${i}`);
    for (const sources of [tooMany, ['GitHub'], ['1password'], ['a'.repeat(33)], ['ok', 7], 'github']) {
      await refused(await ask(device, question({ sources })), 400, 'invalid_sources');
    }
    // A name the control plane has never heard of is fine: plug-ins ship in the engine first.
    const response = await ask(device, question({ sources: ['zotero', 'kicad'] }));
    assert.equal(response.status, 200);
    await response.text();
  });

  test('a malformed request is a 400 naming what is wrong', async () => {
    const device = await signIn('engineer');
    const cases = [
      { requestId: 'short' },
      { requestId: 'x'.repeat(129) },
      { messages: [] },
      { messages: [{ role: 'tool', content: 'x' }] },
      { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PRIVATE!' } }] }] },
      { messages: [{ role: 'assistant', content: 'only an answer' }] },
      { messages: [{ role: 'user', content: 'q', extra: true }] },
      { hard: 'yes' },
      { cacheMarker: 12 },
    ];
    for (const overrides of cases) {
      const body = await refused(await ask(device, question(overrides)), 400, 'invalid_request');
      assert.doesNotMatch(body.error, /PRIVATE/);
    }
  });
});

describe('streams in flight', () => {
  test('a client that hangs up stops the answer upstream and is still charged for what it used', async () => {
    anthropic.state.hold = true;
    const device = await signIn('student');
    const body = question();
    const stream = await openStream(device, body);
    assert.match(stream.received, /"text":"Cloud "/);
    stream.hangUp();

    const row = await ledgerRow(body.requestId);
    await until(() => anthropic.state.dropped === 1, 'the upstream request to be aborted');
    // Input from message_start; output never reported, so estimated from the
    // streamed text ("Cloud answer." is 13 characters).
    const usage = { input_tokens: 1200, output_tokens: Math.ceil('Cloud answer.'.length / 3) };
    assert.equal(row.input_tokens, 1200);
    assert.equal(row.output_tokens, usage.output_tokens);
    assert.equal(Number(row.cost_usd), Number(costUsd('claude-sonnet-5', usage).toFixed(6)));
    assert.deepEqual(row.sources, ['github']);
    assert.equal(row.completed, true);
  });

  test('a client that hangs up still uses up one of the month\'s answers', async () => {
    const device = await signIn('student');
    await answered(device.id, monthlyAnswerLimit('student') - 1);
    anthropic.state.hold = true;
    const body = question();
    (await openStream(device, body)).hangUp();
    assert.equal((await ledgerRow(body.requestId)).completed, true);

    const after = await ask(device, question());
    assert.equal(after.status, 402);
    assert.equal((await after.json()).code, 'answer_limit_reached');
  });

  test('a third concurrent stream is refused, and a request id mid-answer cannot stream twice', async () => {
    anthropic.state.hold = true;
    const device = await signIn('engineer');
    const first = question();
    const second = question();
    const streams = [await openStream(device, first), await openStream(device, second)];
    assert.equal(anthropic.state.requests.length, 2);

    const retry = await ask(device, first);
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).code, 'duplicate_request');

    const third = await ask(device, question());
    assert.equal(third.status, 429);
    assert.equal((await third.json()).code, 'too_many_streams');
    assert.equal(anthropic.state.requests.length, 2, 'the refused requests never reached the model');

    // Another account has its own slots.
    const otherBody = question();
    const other = await openStream(await signIn('student'), otherBody);
    other.hangUp();
    await ledgerRow(otherBody.requestId);

    for (const stream of streams) stream.hangUp();
    await ledgerRow(first.requestId);
    await ledgerRow(second.requestId);
    // The slots free up once the ledger holds the cancelled answers.
    anthropic.state.hold = false;
    await until(async () => {
      const response = await ask(device, question());
      const ok = response.status === 200;
      await response.text();
      return ok;
    }, 'a slot to free up');
  });
});

describe('the refusal order', () => {
  const ORDER = [
    ['cloud_not_in_plan', 403],
    ['platform_cloud_unavailable', 503],
    ['duplicate_request', 409],
    ['answer_limit_reached', 402],
    ['allowance_exhausted', 402],
    ['too_many_streams', 429],
  ];

  // Makes every named refusal's condition true at once on one Student account,
  // and returns the request that should be refused. Streams open first, while
  // the account may still stream; the plan and the key are taken away last.
  async function arrange(conditions) {
    const device = await signIn('student');
    const body = question();
    const held = [];
    if (conditions.includes('too_many_streams')) {
      anthropic.state.hold = true;
      for (let i = 0; i < MAX_STREAMS_PER_ACCOUNT; i++) {
        const streamed = question();
        held.push({ ...(await openStream(device, streamed)), requestId: streamed.requestId });
      }
    }
    if (conditions.includes('duplicate_request')) {
      await recordUsage({ accountId: device.id, requestId: body.requestId, model: 'claude-sonnet-5', costUsd: 0 }, server.pool);
    }
    if (conditions.includes('answer_limit_reached')) await answered(device.id, monthlyAnswerLimit('student'));
    if (conditions.includes('allowance_exhausted')) await spend(device.id, weeklyAllowanceUsd('student'));
    if (conditions.includes('cloud_not_in_plan')) {
      await server.pool.query(`UPDATE accounts SET plan = 'free' WHERE id = $1`, [device.id]);
    }
    if (conditions.includes('platform_cloud_unavailable')) delete process.env.PLATFORM_ANTHROPIC_API_KEY;
    return { device, body, held };
  }

  async function expectRefusal(conditions, [code, status]) {
    const { device, body, held } = await arrange(conditions);
    try {
      const response = await ask(device, body);
      assert.equal(response.status, status, `${conditions.join(' + ')} gave ${response.status}`);
      assert.equal((await response.json()).code, code);
      assert.equal(anthropic.state.requests.length, held.length, 'the refused request never reached the model');
    } finally {
      // The held answers are charged before the next test empties the ledger.
      for (const stream of held) stream.hangUp();
      for (const stream of held) await ledgerRow(stream.requestId);
    }
  }

  // Each condition alone gives its own refusal, so a pair that answers with the
  // earlier code is proof of the order, not of a condition that failed to hold.
  for (const refusal of ORDER) {
    test(`${refusal[0]} alone is a ${refusal[1]}`, () => expectRefusal([refusal[0]], refusal));
  }

  for (const [index, earlier] of ORDER.entries()) {
    for (const [later] of ORDER.slice(index + 1)) {
      test(`${earlier[0]} is answered before ${later}`, () => expectRefusal([earlier[0], later], earlier));
    }
  }

  test('with every condition at once, the plan is what the account hears about', () =>
    expectRefusal(ORDER.map(([code]) => code), ORDER[0]));
});

describe('privacy', () => {
  test('no prompt or answer text reaches a log line or the ledger', async () => {
    const captured = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = Object.fromEntries(methods.map((name) => [name, console[name]]));
    for (const name of methods) {
      console[name] = (...args) => captured.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    }
    const answer = 'PRIVATE-ANSWER-b0ba ';
    try {
      anthropic.state.text = [answer, 'continues.'];
      const device = await signIn('engineer');
      // A finished answer, a failed one and a cancelled one: every path that logs.
      await events(await ask(device, question()));
      anthropic.state.failMidStream = true;
      await events(await ask(device, question()));
      anthropic.state.failMidStream = false;
      anthropic.state.hold = true;
      const cancelled = question();
      const stream = await openStream(device, cancelled);
      stream.hangUp();
      await ledgerRow(cancelled.requestId);
      await until(() => captured.some((line) => line.includes(cancelled.requestId)), 'the cancellation log line');
    } finally {
      Object.assign(console, originals);
    }

    assert.ok(captured.length > 0, 'the failure paths logged something, so the capture is real');
    const logs = captured.join('\n');
    for (const secret of [SECRET_CONTEXT, SECRET_QUESTION, 'PRIVATE-ANSWER', 'Answer from the context', 'Overloaded while']) {
      assert.ok(!logs.includes(secret), `log output contains "${secret}"`);
    }
    const { rows } = await server.pool.query('SELECT * FROM usage_ledger');
    assert.equal(rows.length, 3);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
  });
});
