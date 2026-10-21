import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createGraphPlugin } from '../../src/plugins/graph/index.js';
import {
  checkNode,
  checkOllama,
  checkPgvector,
  checkPortFree,
  checkSandbox,
  databaseName,
  demoDatabaseUrl,
  describePostgresError,
  maintenanceUrl,
  missingModels,
  safeDatabaseName,
} from '../../src/demo/preflight.js';
import { localSigninAllowed } from '../../src/routes/auth.js';
import { demoReply } from '../demoModel.js';

// The demo launcher's checks, the graph plug-in's one capability, and the
// guard on local sign-in. The launcher itself and the seeded demo are covered
// end to end in test/integration/demo.test.js and client/e2e/demo.spec.js.

describe('demo preflight', () => {
  test('Node must be at least the version CI runs', () => {
    assert.equal(checkNode('26.12.0').ok, true);
    assert.equal(checkNode('27.0.0').ok, true);
    const old = checkNode('22.11.0');
    assert.equal(old.ok, false);
    assert.match(old.message, /22\.11\.0 is too old/);
    assert.match(old.fix, /brew install node/);
    assert.equal(checkNode('garbage').ok, false);
  });

  test('the demo database is its own, on the same server as the maintenance database', () => {
    assert.equal(demoDatabaseUrl({}), 'postgresql://localhost:5432/scope_demo');
    assert.equal(demoDatabaseUrl({ DEMO_DATABASE_URL: 'postgresql://me@localhost:5433/other' }), 'postgresql://me@localhost:5433/other');
    assert.equal(maintenanceUrl('postgresql://me@localhost:5433/scope_demo'), 'postgresql://me@localhost:5433/postgres');
    assert.equal(databaseName('postgresql://localhost/scope_demo'), 'scope_demo');
  });

  test('only plain database names are ever put into CREATE DATABASE', () => {
    assert.equal(safeDatabaseName('scope_demo'), true);
    for (const name of ['', 'Scope', 'a-b', 'x"; DROP DATABASE y; --', '1abc', 'a'.repeat(64)]) assert.equal(safeDatabaseName(name), false, name);
  });

  test('a Postgres failure says what to do', () => {
    const url = 'postgresql://localhost:5432/scope_demo';
    const down = describePostgresError({ code: 'ECONNREFUSED' }, url);
    assert.equal(down.ok, false);
    assert.match(down.message, /not running at localhost:5432/);
    assert.match(down.fix, /brew services start postgresql@18/);
    assert.match(describePostgresError({ code: '28000', message: 'role "x" does not exist' }, url).fix, /DEMO_DATABASE_URL/);
    assert.match(describePostgresError(new Error('odd'), url).message, /odd/);
  });

  test('pgvector missing gives the install command', () => {
    assert.equal(checkPgvector(true).ok, true);
    assert.match(checkPgvector(false).fix, /brew install pgvector/);
  });

  test('missing models are named with the exact pull command, untagged names as Ollama resolves them', () => {
    const tags = { models: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen3:4b' }] };
    assert.deepEqual(missingModels(tags, ['nomic-embed-text', 'qwen3:4b']), []);
    assert.deepEqual(missingModels(tags, ['nomic-embed-text', 'qwen3:8b']), [{ model: 'qwen3:8b', fix: 'ollama pull qwen3:8b' }]);
    assert.deepEqual(missingModels({}, ['nomic-embed-text']), [{ model: 'nomic-embed-text', fix: 'ollama pull nomic-embed-text' }]);
  });

  test('Ollama down, models missing, or ready', async () => {
    const answer = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
    const down = await checkOllama({ url: 'http://x', chatModel: 'qwen3:8b', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(down.ok, false);
    assert.match(down.message, /not running at http:\/\/x/);
    const failing = await checkOllama({ url: 'http://x', chatModel: 'qwen3:8b', fetchImpl: answer({}, false) });
    assert.equal(failing.ok, false);

    const missing = await checkOllama({ url: 'http://x', chatModel: 'qwen3:8b', fetchImpl: answer({ models: [{ name: 'nomic-embed-text:latest' }] }) });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /qwen3:8b is not pulled/);
    assert.equal(missing.fix, 'ollama pull qwen3:8b');
    const none = await checkOllama({ url: 'http://x', chatModel: 'qwen3:8b', fetchImpl: answer({ models: [] }) });
    assert.equal(none.fix, 'ollama pull nomic-embed-text\nollama pull qwen3:8b');

    const ready = await checkOllama({ url: 'http://x', chatModel: 'qwen3:8b', fetchImpl: answer({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen3:8b' }] }) });
    assert.equal(ready.ok, true);
  });

  test('no OS sandbox is a warning, not a stop', () => {
    assert.equal(checkSandbox({ platform: 'darwin', find: () => '/usr/bin/sandbox-exec' }).ok, true);
    assert.equal(checkSandbox({ platform: 'linux', find: () => '/usr/bin/bwrap' }).ok, true);
    const none = checkSandbox({ platform: 'linux', find: () => null });
    assert.equal(none.ok, false);
    assert.equal(none.warn, true);
    assert.equal(checkSandbox({ platform: 'win32', find: () => null }).warn, true);
  });

  test('a busy port names the variable that moves it', () => {
    assert.equal(checkPortFree(3001, false).ok, true);
    assert.match(checkPortFree(3001, true).fix, /DEMO_ENGINE_PORT/);
  });
});

describe('graph.write_artifact', () => {
  const capability = createGraphPlugin().capabilities.find((entry) => entry.name === 'graph.write_artifact');

  test('is a write_notes capability every built-in role reaches through the graph tag', () => {
    assert.equal(capability.permission, 'write_notes');
    assert.deepEqual(capability.tags, ['graph']);
    assert.deepEqual(capability.input.required, ['title', 'content']);
  });

  test('returns the artifact for the runner to write back', async () => {
    const result = await capability.run({ title: '  Study   guide ', content: '# Formulas\nT = 2π√(L/g)' });
    assert.deepEqual(result.artifacts, [{ name: 'Study guide', content: '# Formulas\nT = 2π√(L/g)' }]);
    assert.equal(result.output.title, 'Study guide');
    assert.match(result.output.text, /Saved “Study guide” to the map/);
  });

  test('refuses an empty or oversized artifact', async () => {
    await assert.rejects(capability.run({ title: '', content: 'x' }), /title must be a non-empty string/);
    await assert.rejects(capability.run({ title: 'x', content: '   ' }), /content must be a non-empty string/);
    await assert.rejects(capability.run({ title: 'x'.repeat(121), content: 'x' }), /at most 120/);
    await assert.rejects(capability.run({ title: 'x', content: 'x'.repeat(3801) }), /at most 3800/);
    await assert.rejects(capability.run({ title: 'x', content: 42 }), /content must be/);
  });
});

describe('local sign-in guard', () => {
  const env = { SCOPE_LOCAL_USER: 'student@scope-demo.local', NODE_ENV: 'development' };
  const request = ({ address = '127.0.0.1', host = 'localhost:5173', header = '1' } = {}) => ({
    socket: { remoteAddress: address },
    get: (name) => ({ host, 'x-scope-local-signin': header })[name.toLowerCase()],
  });

  test('allows this machine’s own browser', () => {
    assert.equal(localSigninAllowed(request(), env), true);
    assert.equal(localSigninAllowed(request({ address: '::1', host: '[::1]:5173' }), env), true);
    assert.equal(localSigninAllowed(request({ address: '::ffff:127.0.0.1', host: '127.0.0.1:3001' }), env), true);
  });

  test('refuses when local mode is off or the engine is in production', () => {
    assert.equal(localSigninAllowed(request(), {}), false);
    assert.equal(localSigninAllowed(request(), { ...env, NODE_ENV: 'production' }), false);
  });

  test('refuses another machine, another host name, or a request without the header', () => {
    assert.equal(localSigninAllowed(request({ address: '192.168.1.20' }), env), false);
    assert.equal(localSigninAllowed(request({ host: 'evil.example:5173' }), env), false);
    assert.equal(localSigninAllowed(request({ host: '192.168.1.5:5173' }), env), false);
    assert.equal(localSigninAllowed(request({ host: null }), env), false);
    assert.equal(localSigninAllowed(request({ header: null }), env), false);
    assert.equal(localSigninAllowed(request({ header: 'true' }), env), false);
  });
});

describe('the scripted demo model', () => {
  const plan = (goal) => [{ role: 'system', content: 'You plan work for an agent' }, { role: 'user', content: `Goal:\n${goal}\n\nCapabilities:` }];
  const chooser = (goal, step) => [{ role: 'system', content: 'You choose the next single step of a run.' }, { role: 'user', content: `Goal:\n${goal}\n\nThis is step ${step}.\n\nCapabilities:` }];

  test('walks the lab check: analysis, fixes, done', () => {
    const goal = 'Compare it with my lab report draft';
    assert.match(demoReply(plan(goal)), /^1\. Recompute g/);
    assert.equal(JSON.parse(demoReply(chooser(goal, 1))).capability, 'code.run_generated');
    assert.equal(JSON.parse(demoReply(chooser(goal, 2))).capability, 'graph.write_artifact');
    assert.equal(JSON.parse(demoReply(chooser(goal, 3))).done, true);
  });

  test('walks the study guide and ignores anything else', () => {
    const goal = 'Make a one-page study guide';
    assert.equal(JSON.parse(demoReply(chooser(goal, 1))).capability, 'graph.write_artifact');
    assert.equal(JSON.parse(demoReply(chooser(goal, 2))).done, true);
    assert.equal(demoReply(chooser('Fix the build', 1)), null);
    assert.equal(demoReply([{ role: 'user', content: 'What is my lab report about?' }]), null);
  });
});
