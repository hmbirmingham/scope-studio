import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import { LOCAL_DEMO_EMAIL, localModeConfigError, localSigninAllowed } from '../../src/config/localMode.js';
import { DEMO_EMAIL } from '../../src/demo/content.js';
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
  const env = { SCOPE_LOCAL_USER: 'student@scope-demo.local', NODE_ENV: 'development', SCOPE_HOST: '127.0.0.1' };
  const request = ({ address = '127.0.0.1', bound = '127.0.0.1', host = 'localhost:5173', header = '1', ...headers } = {}) => ({
    socket: { remoteAddress: address, server: { address: () => (bound ? { address: bound, port: 3001 } : null) } },
    get: (name) => ({ host, 'x-scope-local-signin': header, ...headers })[name.toLowerCase()] ?? undefined,
  });

  test('allows this machine’s own browser, from its own origin', () => {
    assert.equal(localSigninAllowed(request(), env), true);
    assert.equal(localSigninAllowed(request({ address: '::1', bound: '::1', host: '[::1]:5173' }), env), true);
    assert.equal(localSigninAllowed(request({ address: '::ffff:127.0.0.1', host: '127.0.0.1:3001' }), env), true);
    assert.equal(localSigninAllowed(request({ origin: 'http://localhost:5173' }), env), true);
    assert.equal(localSigninAllowed(request({ origin: 'http://127.0.0.1:5173' }), env), true);
    assert.equal(localSigninAllowed(request({ origin: 'http://[::1]:5173' }), env), true);
  });

  test('(1) needs NODE_ENV=development exactly, not merely “not production”', () => {
    for (const NODE_ENV of [undefined, '', 'test', 'production', 'Development', 'dev']) {
      assert.equal(localSigninAllowed(request(), { ...env, NODE_ENV }), false, String(NODE_ENV));
      assert.match(localModeConfigError({ ...env, NODE_ENV }), /NODE_ENV=development/);
    }
    assert.equal(localModeConfigError(env), null);
    assert.equal(localModeConfigError({}), null, 'no local mode, nothing to refuse');
  });

  test('(2) needs the engine bound to loopback, by configuration and in fact', () => {
    for (const SCOPE_HOST of [undefined, '', '0.0.0.0', '::', '192.168.1.5']) {
      assert.equal(localSigninAllowed(request(), { ...env, SCOPE_HOST }), false, String(SCOPE_HOST));
      assert.match(localModeConfigError({ ...env, SCOPE_HOST }), /SCOPE_HOST/);
    }
    for (const SCOPE_HOST of ['127.0.0.1', '::1', 'localhost']) assert.equal(localModeConfigError({ ...env, SCOPE_HOST }), null);
    // Configured for loopback but actually listening everywhere: refused.
    for (const bound of ['0.0.0.0', '::', '192.168.1.5', null]) {
      assert.equal(localSigninAllowed(request({ bound }), env), false, String(bound));
    }
  });

  test('(3) only ever signs in to the demo account', () => {
    for (const SCOPE_LOCAL_USER of ['hynes@example.com', 'student@scope-demo.local.evil.com', 'admin@scope-demo.local']) {
      assert.equal(localSigninAllowed(request(), { ...env, SCOPE_LOCAL_USER }), false, SCOPE_LOCAL_USER);
      assert.match(localModeConfigError({ ...env, SCOPE_LOCAL_USER }), /only name the demo account/);
    }
    assert.equal(localModeConfigError({ ...env, SCOPE_LOCAL_USER: ' Student@Scope-Demo.local ' }), null);
    assert.equal(LOCAL_DEMO_EMAIL, DEMO_EMAIL);
  });

  test('(4) refuses a request from any other origin', () => {
    for (const origin of ['https://evil.example', 'http://evil.example:5173', 'null', 'http://192.168.1.5:5173', 'https://localhost:5173', 'not a url']) {
      assert.equal(localSigninAllowed(request({ origin }), env), false, origin);
    }
  });

  test('refuses another machine, a forwarded request, another host name, or a request without the header', () => {
    assert.equal(localSigninAllowed(request({ address: '192.168.1.20' }), env), false);
    assert.equal(localSigninAllowed(request({ 'x-forwarded-for': '192.168.1.20' }), env), false);
    assert.equal(localSigninAllowed(request({ forwarded: 'for=192.168.1.20' }), env), false);
    assert.equal(localSigninAllowed(request({ 'x-real-ip': '192.168.1.20' }), env), false);
    assert.equal(localSigninAllowed(request({ host: 'evil.example:5173' }), env), false);
    assert.equal(localSigninAllowed(request({ host: '192.168.1.5:5173' }), env), false);
    assert.equal(localSigninAllowed(request({ host: null }), env), false);
    assert.equal(localSigninAllowed(request({ header: null }), env), false);
    assert.equal(localSigninAllowed(request({ header: 'true' }), env), false);
    // Without the header it can be advertised, never granted.
    assert.equal(localSigninAllowed(request({ header: null }), env, { header: false }), true);
  });

  test('the engine refuses to start with local mode not held to the demo on loopback', async () => {
    const start = (extra) =>
      new Promise((resolve) => {
        execFile(process.execPath, [fileURLToPath(new URL('../../src/index.js', import.meta.url))], {
          env: { ...process.env, PORT: '0', ...extra },
          timeout: 15_000,
        }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr }));
      });
    const listening = await start({ ...env, SCOPE_HOST: '0.0.0.0' });
    assert.equal(listening.code, 1);
    assert.match(listening.stderr, /Refusing to start: SCOPE_LOCAL_USER needs SCOPE_HOST/);
    const realAccount = await start({ ...env, SCOPE_LOCAL_USER: 'hynes@example.com' });
    assert.equal(realAccount.code, 1);
    assert.match(realAccount.stderr, /only name the demo account/);
    const production = await start({ ...env, NODE_ENV: 'production' });
    assert.equal(production.code, 1);
    assert.match(production.stderr, /NODE_ENV=development/);
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
