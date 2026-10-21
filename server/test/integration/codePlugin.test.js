import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createCodePlugin } from '../../src/plugins/code/index.js';
import { registerBuiltInPlugins } from '../../src/plugins/registry.js';
import { capabilitiesForTags, getCapability, getVerifier, listPlugins, resetRegistry } from '../../src/workspace/capabilities.js';
import { createSandbox, createSandboxRunner, removeSandbox, sandboxesDir } from '../../src/workspace/sandbox/index.js';
import { makeRepo, removeTempDirs, tempDir, useDataDir } from './workspaceSandboxFixtures.js';

const linux = process.platform === 'linux';

const PROJECT = {
  'package.json': JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: {
      test: 'node check.js',
      lint: 'node lint.js',
      tsc: 'node -e "process.exit(0)"',
      hello: 'node -e "console.log(\'hello from a declared script\')"',
      online: 'node online.js',
    },
  }, null, 2),
  'check.js': "import('./src/math.js').then(({ add }) => { if (add(2, 2) !== 4) { console.error('add is broken'); process.exit(1); } console.log('all good'); });\n",
  'lint.js': "process.exit(require('fs').readFileSync('src/math.js', 'utf8').includes('var ') ? 1 : 0);\n",
  'online.js': "require('net').connect(9, '127.0.0.1').on('error', (e) => { console.log('offline ' + e.code); process.exit(4); });\n",
  'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n',
  'src/dup.js': 'const x = 1;\nconst x2 = 1;\nlet y = 1;\nlet y2 = 1;\n',
  'docs/notes.md': '# Notes\n-flag looks like an option\n',
};

let data;
let fixture;
let sandbox;
let ctx;

const cap = (name) => getCapability(name);
const run = (name, input, context = ctx) => cap(name).run(input, context);

before(() => {
  data = useDataDir();
  resetRegistry();
  registerBuiltInPlugins();
});
after(() => {
  data.restore();
  removeTempDirs();
});

beforeEach(async () => {
  if (sandbox) await removeSandbox(sandbox).catch(() => {});
  fixture?.cleanup();
  fixture = makeRepo(PROJECT);
  sandbox = await createSandbox({ runId: randomUUID(), repoPath: fixture.repo });
  ctx = { sandbox, localPath: fixture.repo, project: 'fixture' };
});
after(async () => {
  if (sandbox) await removeSandbox(sandbox).catch(() => {});
  fixture?.cleanup();
});

describe('code plug-in registration', () => {
  test('registers through the built-in registry, once', () => {
    registerBuiltInPlugins();
    // Other verticals register beside it; code is there exactly once.
    assert.equal(listPlugins().filter((name) => name === 'code').length, 1);
    assert.ok(listPlugins().includes('graph'));
    assert.equal(cap('code.search').permission, 'read_graph');
    assert.equal(cap('code.read').permission, 'read_graph');
    assert.equal(cap('code.edit').permission, 'edit_files');
    assert.equal(cap('code.run_script').permission, 'run_scripts');
    assert.equal(cap('code.run_generated').permission, 'run_generated_code');
    for (const name of ['code.tests', 'code.build', 'code.typecheck', 'code.lint']) assert.ok(getVerifier(name), name);
    assert.deepEqual(cap('code.edit').verifiers, ['code.typecheck', 'code.lint', 'code.build', 'code.tests']);
  });

  test('roles reach the capabilities through their tags', () => {
    const names = (tags) => capabilitiesForTags(tags).map((c) => c.name).sort();
    assert.deepEqual(names(['code']), ['code.edit', 'code.read', 'code.search']);
    assert.deepEqual(names(['scripts']), ['code.run_script']);
    assert.deepEqual(names(['sandbox']), ['code.run_generated']);
    assert.deepEqual(names(['graph']), ['graph.write_artifact']);
  });
});

describe('code.search', () => {
  test('finds fixed strings with path and line', async () => {
    const { output } = await run('code.search', { query: 'return a + b' });
    assert.deepEqual(output.matches, [{ path: 'src/math.js', line: 2, text: '  return a + b;' }]);
    assert.equal(output.truncated, false);
  });

  test('a query is never an option and regex characters are literal unless asked', async () => {
    const dash = await run('code.search', { query: '-flag' });
    assert.deepEqual(dash.output.matches.map((m) => m.path), ['docs/notes.md']);
    assert.deepEqual((await run('code.search', { query: 'a + b' })).output.matches.length, 1);
    assert.deepEqual((await run('code.search', { query: 'export function (add|sub)', regex: true })).output.matches.length, 2);
  });

  test('limits by path and result count, and reports no match as empty', async () => {
    assert.deepEqual((await run('code.search', { query: 'const', path: 'docs' })).output.matches, []);
    const capped = await run('code.search', { query: '1', path: 'src/dup.js', maxResults: 2 });
    assert.equal(capped.output.matches.length, 2);
    assert.equal(capped.output.total, 4);
    assert.equal(capped.output.truncated, true);
  });

  test('searches the sandbox copy, not the checkout', async () => {
    writeFileSync(join(sandbox.worktree, 'src/math.js'), 'export const onlyInSandbox = true;\n');
    assert.equal((await run('code.search', { query: 'onlyInSandbox' })).output.matches.length, 1);
  });

  test('refuses paths that leave the project', async () => {
    await assert.rejects(run('code.search', { query: 'x', path: '../' }), { code: 'path_escapes' });
    await assert.rejects(run('code.search', { query: 'x', path: '/etc' }), { code: 'path_escapes' });
    // Pathspec magic is just a (missing) file name, not ':(top)' widening the search.
    assert.deepEqual((await run('code.search', { query: 'return', path: ':(top)' })).output.matches, []);
  });

  test("works in the user's checkout when the run has no sandbox", async () => {
    const { output } = await run('code.search', { query: 'return a - b' }, { localPath: fixture.repo });
    assert.equal(output.matches[0].path, 'src/math.js');
  });
});

describe('code.read', () => {
  test('reads a bounded slice of a file', async () => {
    const whole = await run('code.read', { path: 'src/math.js' });
    assert.equal(whole.output.content, PROJECT['src/math.js']);
    assert.equal(whole.output.truncated, false);
    const slice = await run('code.read', { path: 'src/math.js', startLine: 5, maxLines: 2 });
    assert.equal(slice.output.content, 'export function sub(a, b) {\n  return a - b;');
    assert.equal(slice.output.startLine, 5);
    assert.equal(slice.output.truncated, true);
  });

  test('caps a long file', async () => {
    writeFileSync(join(sandbox.worktree, 'big.txt'), 'z'.repeat(300_000));
    const { output } = await run('code.read', { path: 'big.txt' });
    assert.equal(output.content.length, 64 * 1024);
    assert.equal(output.truncated, true);
  });

  test('refuses .., absolute paths, the git directory and missing files', async () => {
    for (const path of ['../outside.txt', 'src/../../outside.txt', '/etc/passwd', '.git', '.git/config', 'src/.git/x', '']) {
      await assert.rejects(run('code.read', { path }), (err) => ['path_escapes', 'invalid_path'].includes(err.code), path);
    }
    await assert.rejects(run('code.read', { path: 'nope.txt' }), { code: 'not_found' });
  });

  test('refuses a symlink that leads out of the project', async () => {
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret-not-real');
    symlinkSync(join(outside, 'secret.txt'), join(sandbox.worktree, 'link.txt'));
    symlinkSync(outside, join(sandbox.worktree, 'linkdir'));
    await assert.rejects(run('code.read', { path: 'link.txt' }), { code: 'path_escapes' });
    await assert.rejects(run('code.read', { path: 'linkdir/secret.txt' }), { code: 'path_escapes' });
    // A symlink that stays inside is fine.
    symlinkSync('src/math.js', join(sandbox.worktree, 'inside.js'));
    assert.match((await run('code.read', { path: 'inside.js' })).output.content, /return a \+ b/);
  });
});

describe('code.edit', () => {
  test('applies a SEARCH/REPLACE that matches once, in the sandbox only', async () => {
    const { output, artifacts } = await run('code.edit', { path: 'src/math.js', search: 'return a + b;', replace: 'return b + a;' });
    assert.equal(readFileSync(join(sandbox.worktree, 'src/math.js'), 'utf8').includes('return b + a;'), true);
    assert.equal(readFileSync(join(fixture.repo, 'src/math.js'), 'utf8'), PROJECT['src/math.js'], "the user's checkout is untouched");
    assert.match(output.diff, /-  return a \+ b;\n\+  return b \+ a;/);
    assert.equal(artifacts[0].kind, 'diff');
    assert.equal(artifacts[0].path, 'src/math.js');
  });

  test('refuses a SEARCH that matches nothing or more than once, leaving the file alone', async () => {
    await assert.rejects(run('code.edit', { path: 'src/math.js', search: 'return a * b;', replace: 'x' }), { code: 'search_not_found' });
    await assert.rejects(run('code.edit', { path: 'src/dup.js', search: ' = 1;', replace: ' = 2;' }), { code: 'search_ambiguous', matches: 4 });
    await assert.rejects(run('code.edit', { path: 'src/math.js', search: '', replace: 'x' }), { code: 'search_required' });
    assert.equal(readFileSync(join(sandbox.worktree, 'src/math.js'), 'utf8'), PROJECT['src/math.js']);
    assert.equal(readFileSync(join(sandbox.worktree, 'src/dup.js'), 'utf8'), PROJECT['src/dup.js']);
  });

  test('creates a new file from an empty SEARCH', async () => {
    const { output } = await run('code.edit', { path: 'src/new/feature.js', search: '', replace: 'export const feature = true;\n' });
    assert.equal(output.created, true);
    assert.equal(readFileSync(join(sandbox.worktree, 'src/new/feature.js'), 'utf8'), 'export const feature = true;\n');
    assert.match(output.diff, /\+export const feature = true;/);
    assert.equal(existsSync(join(fixture.repo, 'src/new')), false);
  });

  test('replacement text is literal, never a pattern', async () => {
    await run('code.edit', { path: 'src/math.js', search: 'return a + b;', replace: "return '$&$1';" });
    assert.match(readFileSync(join(sandbox.worktree, 'src/math.js'), 'utf8'), /return '\$&\$1';/);
  });

  test('refuses to work outside a sandbox', async () => {
    await assert.rejects(run('code.edit', { path: 'src/math.js', search: 'a + b', replace: 'b + a' }, { localPath: fixture.repo }), { code: 'sandbox_required' });
    assert.equal(readFileSync(join(fixture.repo, 'src/math.js'), 'utf8'), PROJECT['src/math.js']);
  });

  test('cannot escape through .., the git directory or a symlink', async () => {
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'target.txt'), 'keep me');
    symlinkSync(join(outside, 'target.txt'), join(sandbox.worktree, 'evil.txt'));
    symlinkSync(outside, join(sandbox.worktree, 'evildir'));
    await assert.rejects(run('code.edit', { path: 'evil.txt', search: 'keep me', replace: 'pwned' }), { code: 'path_escapes' });
    await assert.rejects(run('code.edit', { path: 'evildir/new.txt', search: '', replace: 'pwned' }), { code: 'path_escapes' });
    await assert.rejects(run('code.edit', { path: '../escape.txt', search: '', replace: 'pwned' }), { code: 'path_escapes' });
    await assert.rejects(run('code.edit', { path: '.git', search: '', replace: 'gitdir: /tmp' }), { code: 'path_escapes' });
    assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'keep me');
    assert.deepEqual(readdirSync(outside), ['target.txt']);
  });
});

describe('code.run_script', { skip: !linux && 'runs in the Linux sandbox' }, () => {
  test('runs a declared script inside the sandbox', async () => {
    const { output } = await run('code.run_script', { script: 'hello' });
    assert.equal(output.exitCode, 0, output.output);
    assert.equal(output.sandboxed, true);
    assert.match(output.output, /hello from a declared script/);
  });

  test('a declared script has no network in the sandbox', async () => {
    const { output } = await run('code.run_script', { script: 'online' });
    assert.equal(output.ok, false);
    assert.match(output.output, /offline ECONNREFUSED/);
  });

  test('refuses anything the project does not declare', async () => {
    for (const script of ['build', 'hello; echo pwned', 'rm -rf /', '../hello']) {
      await assert.rejects(run('code.run_script', { script }), (err) => {
        assert.equal(err.code, 'undeclared_script');
        assert.ok(err.available.includes('hello'));
        return true;
      });
    }
  });

  test("without a sandbox, runs in the user's checkout outside the OS sandbox", async () => {
    const { output } = await run('code.run_script', { script: 'hello' }, { localPath: fixture.repo });
    assert.equal(output.sandboxed, false);
    assert.match(output.output, /hello from a declared script/);
  });
});

describe('code.run_generated', { skip: !linux && 'runs in the Linux sandbox' }, () => {
  test('runs Node and Python code and returns the output', async () => {
    const node = await run('code.run_generated', { language: 'node', code: 'console.log([1, 2, 3].map((n) => n * n).join(","))' });
    assert.equal(node.output.ok, true, node.output.output);
    assert.equal(node.output.output, '1,4,9');
    const python = await run('code.run_generated', { language: 'python', code: 'print(", ".join(str(n * n) for n in range(4)))' });
    assert.equal(python.output.output, '0, 1, 4, 9');
  });

  test('can read the project copy but not change it', async () => {
    const code = `
      import { readFileSync, writeFileSync } from 'node:fs';
      console.log(readFileSync(${JSON.stringify(join(sandbox.worktree, 'src/math.js'))}, 'utf8').split('\\n')[0]);
      try { writeFileSync(${JSON.stringify(join(sandbox.worktree, 'src/math.js'))}, 'pwned'); console.log('ESCAPED'); } catch (e) { console.log('read-only ' + e.code); }
      try { readFileSync(${JSON.stringify(join(sandbox.gitDir, 'config'))}); console.log('ESCAPED'); } catch (e) { console.log('no git dir ' + e.code); }
    `;
    const { output } = await run('code.run_generated', { language: 'node', code });
    assert.match(output.output, /export function add/);
    assert.match(output.output, /read-only EROFS/);
    assert.match(output.output, /no git dir ENOENT/);
    assert.doesNotMatch(output.output, /ESCAPED/);
    assert.equal(readFileSync(join(sandbox.worktree, 'src/math.js'), 'utf8'), PROJECT['src/math.js']);
  });

  test('stops at the time limit', async () => {
    const { output } = await run('code.run_generated', { language: 'python', code: 'import time\ntime.sleep(60)', timeoutMs: 500 });
    assert.equal(output.ok, false);
    assert.equal(output.timedOut, true);
  });

  test('without a run sandbox, uses a scratch sandbox and removes it', async () => {
    const before = readdirSync(sandboxesDir());
    const { output } = await run('code.run_generated', { language: 'node', code: 'console.log(process.cwd().includes("scratch"))' }, { localPath: fixture.repo });
    assert.equal(output.output, 'true');
    assert.deepEqual(readdirSync(sandboxesDir()), before);
  });

  test('rejects an unknown language or missing code', async () => {
    await assert.rejects(run('code.run_generated', { language: 'bash', code: 'echo hi' }), { code: 'invalid_input' });
    await assert.rejects(run('code.run_generated', { language: 'node', code: '' }), { code: 'invalid_input' });
  });
});

describe('code verifiers', { skip: !linux && 'runs in the Linux sandbox' }, () => {
  const verify = (name, context = ctx) => getVerifier(name).verify({}, context);

  test('pass when the declared script passes and fail when it fails', async () => {
    const passing = await verify('code.tests');
    assert.equal(passing.ok, true, passing.detail);
    assert.match(passing.detail, /npm run test passed/);

    await run('code.edit', { path: 'src/math.js', search: 'return a + b;', replace: 'return a - b;' });
    const failing = await verify('code.tests');
    assert.equal(failing.ok, false);
    assert.match(failing.detail, /add is broken/);

    await run('code.edit', { path: 'src/math.js', search: 'export function add', replace: 'var broken = 1;\nexport function add' });
    assert.equal((await verify('code.lint')).ok, false);
  });

  test('typecheck uses whichever name the project declares', async () => {
    const result = await verify('code.typecheck');
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.script, 'tsc');
  });

  test('report unavailable, not failed, when the project declares no such script', async () => {
    assert.deepEqual(await verify('code.build'), { ok: true, unavailable: true, detail: 'the project declares no "build" script' });
    assert.equal((await verify('code.tests', { localPath: tempDir('bare') })).unavailable, true);
    assert.equal((await verify('code.tests', {})).unavailable, true);
  });

  test("npm init's placeholder test script is not a test suite", async () => {
    const placeholder = makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    try {
      const result = await verify('code.tests', { localPath: placeholder.repo });
      assert.equal(result.unavailable, true);
    } finally {
      placeholder.cleanup();
    }
  });
});

// A machine where bubblewrap is missing or blocked. In the sandbox copy a
// declared script is model-written code (code.edit can change package.json,
// the tests and the sources), so it must never fall back to running on the
// host.
describe('without an OS sandbox', () => {
  const unsandboxed = createCodePlugin({ sandbox: createSandboxRunner({ platform: 'unsupported-os' }) });
  const capability = (name) => unsandboxed.capabilities.find((entry) => entry.name === name);
  const verifier = (name) => unsandboxed.verifiers.find((entry) => entry.name === name);

  // What a model could do with code.edit alone: make the test script write
  // to the host. The marker must never appear.
  async function plantHostWrite() {
    const marker = join(tempDir('marker'), 'ran-on-host');
    await run('code.edit', {
      path: 'check.js',
      search: "import('./src/math.js')",
      replace: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'escaped');\nimport('./src/math.js')`,
    });
    return marker;
  }

  test('code.run_script refuses in the sandbox copy and runs nothing', async () => {
    const marker = await plantHostWrite();
    await assert.rejects(capability('code.run_script').run({ script: 'test' }, ctx), (err) => {
      assert.equal(err.code, 'sandbox_unavailable');
      return true;
    });
    assert.equal(existsSync(marker), false, 'the edited script ran outside the OS sandbox');
  });

  test('the verifiers on code.edit report not verified and run nothing', async () => {
    const marker = await plantHostWrite();
    const result = await verifier('code.tests').verify({}, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.unverified, true);
    assert.match(result.detail, /was not run: no OS sandbox is available/);
    assert.equal(existsSync(marker), false, 'the edited script ran outside the OS sandbox');
  });

  test('a project with no such script is still reported unavailable, not failed', async () => {
    assert.deepEqual(await verifier('code.build').verify({}, ctx), { ok: true, unavailable: true, detail: 'the project declares no "build" script' });
  });

  test('code.run_generated refuses', async () => {
    await assert.rejects(capability('code.run_generated').run({ language: 'node', code: 'console.log(1)' }, ctx), { code: 'sandbox_unavailable' });
  });

  test("the user's own checkout, which nothing edits, still runs its declared scripts as /api/runs does", async () => {
    const { output } = await capability('code.run_script').run({ script: 'hello' }, { localPath: fixture.repo });
    assert.equal(output.sandboxed, false);
    assert.match(output.output, /hello from a declared script/);
  });
});
