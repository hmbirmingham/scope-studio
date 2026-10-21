import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_MAX_STEPS, budgetError, effectiveBudget, exceededLimit, wallRemaining } from '../../src/workspace/runner/budget.js';
import { chooserMessages, extractJsonObject, parseChoice, validateInput } from '../../src/workspace/runner/chooser.js';
import { createModelRouter } from '../../src/workspace/runner/models.js';
import { advance } from '../../src/workspace/runner/scheduler.js';
import { RUN_NODE_WINDOW, SLICE_NODES, SLICE_TOKENS, packSlice } from '../../src/workspace/runner/slice.js';
import { notesFrom, stepContent } from '../../src/workspace/runner/writeBack.js';
import { createFakeModelPort } from '../fakeModelPort.js';

describe('step chooser parsing', () => {
  test('takes the first JSON object out of prose, fences and think blocks', () => {
    const text = '<think>{"capability": "x.y"}</think>Sure!\n```json\n{"capability": "code.search", "input": {"query": "a } b"}, "summary": "look"}\n```\nthen {"other": 1}';
    assert.deepEqual(parseChoice(text), {
      ok: true,
      choice: { capability: 'code.search', input: { query: 'a } b' }, hard: false, done: false, summary: 'look' },
    });
    assert.equal(extractJsonObject('no braces here'), null);
    assert.equal(extractJsonObject('{"open": "never closed"'), null);
  });

  test('done needs no capability; everything else does', () => {
    assert.deepEqual(parseChoice('{"done": true, "summary": "finished"}').choice, { capability: null, input: {}, hard: false, done: true, summary: 'finished' });
    assert.equal(parseChoice('{"input": {}}').error, 'chooser_no_capability');
  });

  test('refuses anything that is not one well-typed object', () => {
    const cases = {
      'just words': 'chooser_not_json',
      '{"capability": "a.b",}': 'chooser_not_json',
      '{"capability": 3}': 'chooser_capability_not_string',
      '{"capability": ""}': 'chooser_capability_not_string',
      '{"capability": "a.b", "input": [1]}': 'chooser_input_not_object',
      '{"capability": "a.b", "input": null}': 'chooser_input_not_object',
      '{"capability": "a.b", "hard": "yes"}': 'chooser_hard_not_boolean',
      '{"capability": "a.b", "done": 1}': 'chooser_done_not_boolean',
      '{"capability": "a.b", "summary": 5}': 'chooser_summary_not_string',
    };
    for (const [text, error] of Object.entries(cases)) assert.deepEqual(parseChoice(text), { ok: false, error }, text);
    assert.equal(parseChoice(`{"capability": "a.b", "summary": "${'x'.repeat(900)}"}`).choice.summary.length, 500);
  });

  test('validates input against the capability schema', () => {
    const schema = {
      type: 'object',
      required: ['query', 'limit'],
      properties: { query: { type: 'string' }, limit: { type: 'integer' }, exact: { type: 'boolean' }, mode: { type: 'string', enum: ['a', 'b'] }, tags: { type: 'array' }, score: { type: ['number', 'null'] } },
    };
    assert.equal(validateInput(schema, { query: 'q', limit: 3, exact: true, mode: 'a', tags: [], score: null, extra: 1 }), null);
    assert.equal(validateInput(schema, { query: 'q' }), 'input.limit is required');
    assert.equal(validateInput(schema, { query: 1, limit: 3 }), 'input.query must be string');
    assert.equal(validateInput(schema, { query: 'q', limit: 2.5 }), 'input.limit must be integer');
    assert.equal(validateInput(schema, { query: 'q', limit: 1, exact: 'true' }), 'input.exact must be boolean');
    assert.equal(validateInput(schema, { query: 'q', limit: 1, mode: 'c' }), 'input.mode must be one of a, b');
    assert.equal(validateInput(schema, { query: 'q', limit: 1, score: 'high' }), 'input.score must be number or null');
    assert.equal(validateInput({ ...schema, additionalProperties: false }, { query: 'q', limit: 1, extra: 1 }), 'input.extra is not allowed');
    assert.equal(validateInput(schema, null), 'input must be an object');
  });

  test('the chooser prompt carries the goal, the slice and the capabilities, not a transcript', () => {
    const messages = chooserMessages({
      agent: { role: { embodiment: 'You are careful.', title: 'Builder' } },
      goal: 'Fix the bug',
      slice: [{ id: 'n1', type: 'finding', project: 'p', content: 'the bug is in parse()' }],
      capabilities: [{ name: 'code.search', description: 'search code', input: { required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } } }],
      stepIndex: 7,
    });
    assert.match(messages[0].content, /You are careful\. Your role: Builder\./);
    assert.match(messages[1].content, /Goal:\nFix the bug/);
    assert.match(messages[1].content, /- code\.search\(query: string, limit\?: integer\) — search code/);
    assert.match(messages[1].content, /\[finding · p · n1\]\nthe bug is in parse\(\)/);
    assert.match(messages[1].content, /step 7/);
  });
});

describe('run budgets', () => {
  test('a run overrides the agent per limit, and every run has a step limit', () => {
    assert.deepEqual(effectiveBudget({ maxTokens: 1000, maxUsd: 1 }, { maxUsd: 0.5, maxWallMs: null }), { maxTokens: 1000, maxUsd: 0.5, maxWallMs: null, maxSteps: DEFAULT_MAX_STEPS });
    assert.deepEqual(effectiveBudget({ maxSteps: 5, maxTokens: -1 }, {}), { maxTokens: null, maxUsd: null, maxWallMs: null, maxSteps: 5 });
    assert.equal(effectiveBudget(undefined, undefined).maxSteps, DEFAULT_MAX_STEPS);
  });

  test('stops at the first limit reached', () => {
    const budget = { maxTokens: 100, maxUsd: 0.1, maxWallMs: 1000, maxSteps: 3 };
    assert.equal(exceededLimit(budget, { tokens: 99, usd: 0.09, wallMs: 999, steps: 2 }), null);
    assert.equal(exceededLimit(budget, { tokens: 100 }), 'tokens');
    assert.equal(exceededLimit(budget, { usd: 0.1 }), 'usd');
    assert.equal(exceededLimit(budget, { wallMs: 1000 }), 'wall');
    assert.equal(exceededLimit(budget, { steps: 3 }), 'steps');
    assert.equal(exceededLimit({ maxSteps: null }, { tokens: 1e9, steps: 1e9 }), null);
    assert.equal(wallRemaining(budget, 400), 600);
    assert.equal(wallRemaining(budget, 4000), 0);
    assert.equal(wallRemaining({ maxWallMs: null }, 4000), null);
  });

  test('validates a per-run override', () => {
    assert.equal(budgetError(undefined), null);
    assert.equal(budgetError({ maxTokens: 10, maxSteps: null }), null);
    assert.equal(budgetError([]), 'budget must be an object');
    assert.equal(budgetError({ maxTokens: 0 }), 'budget.maxTokens must be a positive number');
    assert.equal(budgetError({ maxTokens: 'lots' }), 'budget.maxTokens must be a positive number');
    assert.equal(budgetError({ forever: 1 }), 'budget.forever is not a budget limit');
  });
});

describe('scheduler', () => {
  test('advances to the next slot after now, never replaying missed ones', () => {
    const now = new Date('2026-03-02T10:07:30Z');
    assert.equal(advance('*/15 * * * *', new Date('2026-03-02T10:00:00Z'), now).toISOString(), '2026-03-02T10:15:00.000Z');
    assert.equal(advance('0 * * * *', new Date('2026-03-01T02:00:00Z'), now).toISOString(), '2026-03-02T11:00:00.000Z');
    // A slot in the future (a scheduler running early) advances past the slot itself.
    assert.equal(advance('0 12 * * *', new Date('2026-03-02T12:00:00Z'), now).toISOString(), '2026-03-03T12:00:00.000Z');
    assert.equal(advance('not a schedule', now, now), null);
  });
});

describe('graph slice packing', () => {
  const agent = { scopes: { read: { projects: ['p'], sources: ['github'] } } };
  const node = (id, { tokens = 200, source = 'github', project = 'p', privacy = 'cloud', type = 'file' } = {}) => ({
    id, type, content: `${id} `.repeat(tokens), source, project, privacy, token_length: tokens,
  });
  const retrieved = Array.from({ length: 10 }, (_, i) => ({ node: node(`r${i}`, { tokens: 300 }), score: 1 - i * 0.05 }));
  const fakeGather = (candidates) => async () => ({ candidates });
  function fakeDb(nodes) {
    return { query: async (sql, [, ids]) => ({ rows: nodes.filter((entry) => ids.includes(entry.id)) }) };
  }

  async function sliceAt(step, extra = []) {
    const written = Array.from({ length: step }, (_, i) => node(`w${step - i}`, { source: 'agent', type: 'finding', tokens: 150 }));
    const planNode = node('plan', { source: 'agent', type: 'plan', tokens: 250 });
    return packSlice({
      ownerId: 'o',
      agent,
      goal: 'g',
      project: 'p',
      planNodeId: 'plan',
      runNodeIds: written.map((entry) => entry.id),
      gather: fakeGather([...retrieved, ...extra]),
      db: fakeDb([planNode, ...written]),
    });
  }

  test('the slice has the same budget at step 40 as at step 2', async () => {
    const early = await sliceAt(2);
    const late = await sliceAt(40);
    for (const slice of [early, late]) {
      assert.ok(slice.tokens <= SLICE_TOKENS, `${slice.tokens} tokens`);
      assert.ok(slice.nodes.length <= SLICE_NODES);
      assert.equal(slice.tokens, slice.nodes.reduce((sum, entry) => sum + entry.token_length, 0));
    }
    // Once the run has written enough, the slice is full and stops growing.
    assert.equal(late.tokens, (await sliceAt(20)).tokens);
    assert.ok(late.tokens >= SLICE_TOKENS - 300, 'a full slice uses its budget');
  });

  test('the plan and the most recent notes compete for the slice; older ones age out', async () => {
    const slice = await sliceAt(40);
    const ids = slice.nodes.map((entry) => entry.id);
    assert.equal(ids[0], 'plan');
    assert.ok(ids.includes('w40'), 'the newest note is offered first');
    assert.ok(!ids.includes('w1'), 'the oldest note is outside the window');
    assert.ok(!ids.includes(`w${40 - RUN_NODE_WINDOW}`));
    // Run notes are boosted, not exclusive: a retrieval hit can still win a slot over an older note.
    const early = await sliceAt(2);
    assert.ok(early.nodes.some((entry) => entry.id.startsWith('r')));
  });

  test('retrieval candidates outside the read scope never enter the slice', async () => {
    const slice = await sliceAt(1, [
      { node: node('elsewhere', { project: 'q', tokens: 10 }), score: 99 },
      { node: node('notion', { source: 'notion', tokens: 10 }), score: 99 },
    ]);
    const ids = slice.nodes.map((entry) => entry.id);
    assert.ok(!ids.includes('elsewhere'));
    assert.ok(!ids.includes('notion'));
    assert.ok(ids.includes('w1'), 'the run’s own notes are readable to it');
  });

  test('a private node in the slice marks the context private', async () => {
    assert.equal((await sliceAt(1)).privateContext, false);
    const slice = await sliceAt(1, [{ node: node('secret', { privacy: 'local', tokens: 10 }), score: 99 }]);
    assert.ok(slice.nodes.some((entry) => entry.id === 'secret'));
    assert.equal(slice.privateContext, true);
  });
});

describe('model call order', () => {
  const run = { id: 'run', owner_id: 'owner', project: 'p' };
  const agentWith = (fields) => ({ id: 'a', state: 'active', level: 'agentic', modelPolicy: 'local_cloud', scopes: {}, ...fields });
  const adapters = { local: createFakeModelPort({ name: 'local' }), platform: createFakeModelPort({ name: 'platform' }) };
  const router = (agent, { online = true, userPlan = 'engineer', db } = {}) =>
    createModelRouter({ agent, run, userPlan, online, adapters, publish: () => {}, db: db ?? { query: async () => assert.fail('no query expected') } });

  test('local adapters are used without asking can()', async () => {
    assert.deepEqual(await router(agentWith({ modelPolicy: 'local_only' })).choose({ purpose: 'plan', privateContext: false }), { name: 'local', reason: 'policy' });
    assert.deepEqual(await router(agentWith({})).choose({ purpose: 'step', hard: false, privateContext: false }), { name: 'local', reason: 'execution_step' });
    assert.deepEqual(await router(agentWith({})).choose({ purpose: 'plan', privateContext: true }), { name: 'local', reason: 'private_context' });
    assert.deepEqual(await router(agentWith({}), { online: false }).choose({ purpose: 'plan', privateContext: false }), { name: 'local', reason: 'offline' });
  });

  test('can() decides the cloud: allow uses it, deny keeps local', async () => {
    assert.equal((await router(agentWith({})).choose({ purpose: 'plan', privateContext: false })).name, 'platform');
    assert.equal((await router(agentWith({})).choose({ purpose: 'step', hard: true, privateContext: false })).name, 'platform');
    assert.deepEqual(await router(agentWith({ overrides: { cloud_model: 'deny' } })).choose({ purpose: 'plan', privateContext: false }), { name: 'local', reason: 'cloud_denied:override' });
  });

  test('ask opens the run’s request and stays local while it is pending', async () => {
    const queries = [];
    const db = {
      query: async (sql, values) => {
        queries.push(sql);
        if (sql.startsWith('SELECT')) return { rows: [] };
        return { rows: [{ id: 'ap1', status: 'pending' }] };
      },
    };
    const choice = await router(agentWith({ level: 'supervised' }), { db }).choose({ purpose: 'plan', privateContext: false });
    assert.deepEqual(choice, { name: 'local', reason: 'cloud_pending' });
    assert.equal(queries.filter((sql) => sql.includes('INSERT INTO agent_approvals')).length, 1);
  });

  test('every call must say whether its context is private', async () => {
    await assert.rejects(router(agentWith({})).choose({ purpose: 'plan' }), /private/);
    assert.throws(() => createModelRouter({ agent: agentWith({}), run, adapters, publish: () => {} }), /online/);
  });
});

describe('write-back content', () => {
  test('keeps findings, decisions, questions and artifacts, bounded', () => {
    const notes = notesFrom({
      output: 'x',
      findings: ['a finding', { content: 'another' }, '', 7],
      decisions: [{ content: { chose: 'b' } }],
      questions: ['why?'],
      artifacts: [{ name: 'report.md', content: '# Report' }],
    });
    assert.deepEqual(notes, [
      { type: 'finding', content: 'a finding' },
      { type: 'finding', content: 'another' },
      { type: 'decision', content: '{"chose":"b"}' },
      { type: 'question', content: 'why?' },
      { type: 'artifact', content: 'report.md\n\n# Report' },
    ]);
    assert.equal(notesFrom({ findings: Array.from({ length: 30 }, (_, i) => `f${i}`) }).length, 10);
    assert.equal(notesFrom({ findings: ['y'.repeat(9000)] })[0].content.length, 4000);
    assert.deepEqual(notesFrom(null), []);
  });

  test('a step node says what happened, with a bounded outcome', () => {
    const content = stepContent({ index: 3, capability: 'code.search', status: 'failed', summary: 'look for parse', reason: 'verification_failed', output: 'z'.repeat(5000) });
    assert.match(content, /^Step 3 · code\.search · failed\nlook for parse\nReason: verification_failed\nOutcome: z+…$/);
    assert.ok(content.length < 1000);
  });
});

describe('fake model port', () => {
  test('replays scripted replies in order, records calls and reports usage', async () => {
    const port = createFakeModelPort({ responses: ['hello', { a: 1 }, (request) => `echo ${request.purpose}`, new Error('boom')], fallback: 'later' });
    const read = async (purpose) => {
      let text = '';
      let done;
      for await (const chunk of port.stream({ messages: [], purpose })) {
        if (chunk.done) done = chunk;
        else text += chunk.text;
      }
      return { text, done };
    };
    assert.equal((await read('plan')).text, 'hello');
    assert.equal((await read('step')).text, '{"a":1}');
    assert.equal((await read('step')).text, 'echo step');
    await assert.rejects(read('step'), /boom/);
    const last = await read('step');
    assert.equal(last.text, 'later');
    assert.deepEqual(last.done.usage, { input_tokens: 100, output_tokens: 20 });
    assert.equal(port.calls.length, 5);
  });
});
