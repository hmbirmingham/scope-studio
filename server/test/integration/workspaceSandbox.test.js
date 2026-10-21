import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  createSandbox,
  createSandboxRunner,
  removeSandbox,
  runSandboxed,
  sandboxStatus,
  sandboxesDir,
  withSandbox,
} from '../../src/workspace/sandbox/index.js';
import { makeRepo, processesWith, removeTempDirs, tempDir, useDataDir } from './workspaceSandboxFixtures.js';

// These tests run real code inside the real OS sandbox and check that what
// must fail does fail. CI installs bubblewrap and allows user namespaces;
// on Linux a missing sandbox is a test failure, not a skip, so a broken CI
// image can never quietly turn the escape tests off.
const linux = process.platform === 'linux';

let data;
let work;
before(() => {
  data = useDataDir();
  work = tempDir('sandbox-work');
});
after(() => {
  data.restore();
  removeTempDirs();
});

function scratchDir() {
  const dir = join(work, randomUUID());
  mkdirSync(dir);
  return dir;
}

async function runNode(code, options = {}) {
  const cwd = options.cwd ?? scratchDir();
  const file = join(cwd, `probe-${randomUUID()}.mjs`);
  writeFileSync(file, code);
  return { cwd, file, result: await runSandboxed({ command: 'node', args: [file], cwd, timeoutMs: 20_000, ...options }) };
}

async function runPython(code, options = {}) {
  const cwd = options.cwd ?? scratchDir();
  const file = join(cwd, `probe-${randomUUID()}.py`);
  writeFileSync(file, code);
  return { cwd, file, result: await runSandboxed({ command: 'python3', args: [file], cwd, timeoutMs: 20_000, ...options }) };
}

describe('the OS sandbox', { skip: !linux && 'the escape tests run on Linux (CI)' }, () => {
  test('is available here', async () => {
    const status = await sandboxStatus();
    assert.equal(status.available, true, status.reason ?? '');
    assert.equal(status.mechanism, 'bwrap');
  });

  test('runs ordinary Node and Python code and returns its output', async () => {
    const node = await runNode('console.log(6 * 7); console.error("to stderr");');
    assert.equal(node.result.ok, true, node.result.output);
    assert.equal(node.result.exitCode, 0);
    assert.match(node.result.output, /^42\n?to stderr$/m);

    const python = await runPython('import sys\nprint(sum(range(10)))\nprint(sys.version_info[0])');
    assert.equal(python.result.ok, true, python.result.output);
    assert.equal(python.result.output, '45\n3');
  });

  test('the code can write in its own directory', async () => {
    const { cwd, result } = await runNode('import { writeFileSync } from "node:fs"; writeFileSync("out.txt", "made inside");');
    assert.equal(result.ok, true, result.output);
    assert.equal(readFileSync(join(cwd, 'out.txt'), 'utf8'), 'made inside');
  });

  test('cannot connect to a TCP server on the host loopback', async () => {
    let connections = 0;
    const server = createTcpServer((socket) => {
      connections += 1;
      socket.end('hello from the host');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const { result } = await runNode(`
        import { connect } from 'node:net';
        const socket = connect(${port}, '127.0.0.1');
        socket.on('data', (d) => { console.log('ESCAPED ' + d); process.exit(0); });
        socket.on('error', (e) => { console.log('blocked ' + e.code); process.exit(3); });
      `);
      assert.equal(result.exitCode, 3, result.output);
      assert.match(result.output, /blocked ECONNREFUSED/);
      assert.doesNotMatch(result.output, /ESCAPED/);

      const python = await runPython(`
import socket, sys
try:
    socket.create_connection(("127.0.0.1", ${port}), timeout=2)
    print("ESCAPED")
except OSError as e:
    print("blocked", type(e).__name__)
    sys.exit(3)
`);
      assert.equal(python.result.exitCode, 3, python.result.output);
      assert.equal(connections, 0, 'the host server never saw a connection');
    } finally {
      server.close();
    }
  });

  test('cannot resolve names or fetch over HTTP', async () => {
    let requests = 0;
    const server = createHttpServer((req, res) => {
      requests += 1;
      res.end('ESCAPED');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const { result } = await runNode(`
        import { lookup } from 'node:dns/promises';
        const outcomes = [];
        try { await lookup('example.com'); outcomes.push('dns ESCAPED'); } catch (e) { outcomes.push('dns blocked ' + e.code); }
        try { const r = await fetch('http://127.0.0.1:${port}/'); outcomes.push('http ' + await r.text()); } catch (e) { outcomes.push('http blocked'); }
        try { await fetch('http://example.com/'); outcomes.push('remote ESCAPED'); } catch (e) { outcomes.push('remote blocked'); }
        console.log(outcomes.join('\\n'));
      `);
      assert.equal(result.ok, true, result.output);
      assert.doesNotMatch(result.output, /ESCAPED/);
      assert.match(result.output, /dns blocked/);
      assert.match(result.output, /http blocked/);
      assert.match(result.output, /remote blocked/);
      assert.equal(requests, 0);
    } finally {
      server.close();
    }
  });

  test('cannot write outside its directory', async () => {
    const outside = tempDir('outside');
    const target = join(outside, 'pwned.txt');
    const { result } = await runNode(`
      import { writeFileSync } from 'node:fs';
      for (const path of [${JSON.stringify(target)}, '/usr/pwned-${randomUUID()}', '/pwned']) {
        try { writeFileSync(path, 'x'); console.log('ESCAPED ' + path); } catch (e) { console.log('blocked ' + e.code); }
      }
    `);
    assert.equal(result.ok, true, result.output);
    assert.doesNotMatch(result.output, /ESCAPED/);
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(outside), []);
  });

  test("cannot read the user's checkout or home directory", async () => {
    const { repo, cleanup } = makeRepo({ 'secret.txt': 'repo-secret-not-real' });
    try {
      const { result } = await runNode(`
        import { readFileSync, readdirSync } from 'node:fs';
        for (const read of [() => readFileSync(${JSON.stringify(join(repo, 'secret.txt'))}, 'utf8'), () => readdirSync(${JSON.stringify(homedir())}).join(',')]) {
          try { console.log('ESCAPED ' + read()); } catch (e) { console.log('blocked ' + e.code); }
        }
        console.log('HOME=' + process.env.HOME);
      `, { protect: [repo] });
      assert.equal(result.ok, true, result.output);
      assert.doesNotMatch(result.output, /ESCAPED|repo-secret/);
      assert.match(result.output, /HOME=\/tmp/);
    } finally {
      cleanup();
    }
  });

  test('refuses to mount the checkout or an ancestor of home', async () => {
    const { repo, cleanup } = makeRepo({ 'a.txt': 'a' });
    try {
      await assert.rejects(runSandboxed({ command: 'node', args: ['-e', '0'], cwd: repo, writable: [repo], protect: [repo] }), { code: 'invalid_sandbox_request' });
      mkdirSync(join(repo, 'sub'));
      await assert.rejects(runSandboxed({ command: 'node', args: ['-e', '0'], cwd: join(repo, 'sub'), writable: [join(repo, 'sub')], protect: [repo] }), { code: 'invalid_sandbox_request' });
      const cwd = scratchDir();
      await assert.rejects(runSandboxed({ command: 'node', args: ['-e', '0'], cwd, readOnly: [repo], protect: [repo] }), { code: 'invalid_sandbox_request' });
      await assert.rejects(runSandboxed({ command: 'node', args: ['-e', '0'], cwd: '/', writable: ['/'] }), { code: 'invalid_sandbox_request' });
    } finally {
      cleanup();
    }
  });

  test('a home directory never leaks through a sandbox home that is a temp dir', async () => {
    const fakeHome = tempDir('home');
    writeFileSync(join(fakeHome, 'credentials'), 'home-secret-not-real');
    const runner = createSandboxRunner({ home: fakeHome });
    const cwd = scratchDir();
    const result = await runner.run({ command: 'node', args: ['-e', `try { console.log(require('fs').readFileSync(${JSON.stringify(join(fakeHome, 'credentials'))}, 'utf8')) } catch (e) { console.log('blocked ' + e.code) }`], cwd });
    assert.match(result.output, /blocked ENOENT/);
  });

  test('starts with a clean environment', async () => {
    process.env.SCOPE_SANDBOX_PROBE = 'host-only-value-not-real';
    try {
      const { result } = await runNode('console.log(Object.keys(process.env).sort().join(","))');
      assert.equal(result.ok, true, result.output);
      assert.doesNotMatch(result.output, /SCOPE_SANDBOX_PROBE|DATABASE_URL|SESSION_SECRET/);
    } finally {
      delete process.env.SCOPE_SANDBOX_PROBE;
    }
  });

  test('a fork bomb hits the process limit and leaves nothing running', async () => {
    const marker = `forkbomb-${randomUUID()}`;
    const cwd = scratchDir();
    const file = join(cwd, `${marker}.py`);
    writeFileSync(file, `
import os, time
blocked = 0
for _ in range(10000):
    try:
        if os.fork() == 0:
            time.sleep(30)
            os._exit(0)
    except OSError:
        blocked += 1
print("forks refused", blocked)
`);
    const result = await runSandboxed({ command: 'python3', args: [file], cwd, timeoutMs: 15_000, maxProcesses: 32 });
    assert.match(result.output, /forks refused [1-9]/);
    // The children were still sleeping when the parent exited; the sandbox's
    // pid namespace takes them down with it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(processesWith(marker), []);
  });

  test('a memory hog is stopped by the memory limit', async () => {
    const python = await runPython('x = bytearray(1024 * 1024 * 1024)\nprint("ESCAPED")', { memoryMb: 128 });
    assert.equal(python.result.ok, false);
    assert.match(python.result.output, /MemoryError/);
    assert.doesNotMatch(python.result.output, /ESCAPED/);

    const node = await runNode('const keep = []; for (let i = 0; i < 4096; i++) keep.push(Buffer.alloc(1 << 20, 1)); console.log("ESCAPED");', { memoryMb: 128 });
    assert.equal(node.result.ok, false);
    assert.doesNotMatch(node.result.output, /ESCAPED/);
  });

  test('an infinite loop is stopped by the CPU limit', async () => {
    const { result } = await runNode('for (;;) {}', { cpuSeconds: 1, timeoutMs: 15_000 });
    assert.equal(result.ok, false);
    assert.equal(result.limit, 'cpu');
    assert.ok(result.durationMs < 10_000);
  });

  test('a process that waits forever is killed at the wall clock, with its children', async () => {
    const marker = `sleeper-${randomUUID()}`;
    const cwd = scratchDir();
    const file = join(cwd, `${marker}.py`);
    writeFileSync(file, 'import os, time\nif os.fork() == 0:\n    time.sleep(60)\ntime.sleep(60)\n');
    const result = await runSandboxed({ command: 'python3', args: [file], cwd, timeoutMs: 1_000 });
    assert.equal(result.timedOut, true);
    assert.equal(result.limit, 'timeout');
    assert.ok(result.durationMs < 5_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(processesWith(marker), []);
  });

  test('a file larger than the file-size limit cannot be written', async () => {
    const { cwd, result } = await runPython('open("big.bin", "wb").write(b"x" * 8 * 1024 * 1024)\nprint("ESCAPED")', { maxFileMb: 1 });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.output, /ESCAPED/);
    assert.ok(readFileSync(join(cwd, 'big.bin')).length <= 1024 * 1024);
  });

  test('output is capped', async () => {
    const { result } = await runNode('process.stdout.write("y".repeat(200000))', { maxOutput: 1000 });
    assert.equal(result.truncated, true);
    assert.ok(result.output.length < 1100);
  });

  test('an aborted step stops its process', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const { result } = await runNode('setInterval(() => {}, 1000)', { signal: controller.signal, timeoutMs: 20_000 });
    assert.equal(result.ok, false);
    assert.equal(result.limit, 'aborted');
  });
});

// As root the sandbox directory is handed to an unprivileged uid before each
// run. The directory belongs to the sandboxed code, which can leave symlinks
// to any host path in it for the next run to trip over.
describe('handing the sandbox directory over between runs', { skip: (!linux || process.geteuid?.() !== 0) && 'only root hands files over, on Linux' }, () => {
  function victim() {
    const dir = tempDir('victim');
    const file = join(dir, 'host-secret');
    writeFileSync(file, 'host only', { mode: 0o600 });
    const inner = join(dir, 'inner');
    mkdirSync(inner, { mode: 0o700 });
    writeFileSync(join(inner, 'nested-secret'), 'host only', { mode: 0o600 });
    return { dir, file, inner, nested: join(inner, 'nested-secret') };
  }
  const owner = (path) => {
    const stat = statSync(path);
    return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 };
  };

  test('a symlink left by one run never changes the owner of the host file it points at', async () => {
    const host = victim();
    const cwd = scratchDir();
    const before = [host.dir, host.file, host.inner, host.nested].map(owner);
    const plant = await runNode(`
      import { symlinkSync } from 'node:fs';
      symlinkSync(${JSON.stringify(host.file)}, 'file-link');
      symlinkSync(${JSON.stringify(host.dir)}, 'dir-link');
      symlinkSync(${JSON.stringify(host.inner)}, 'inner-link');
      console.log('planted');
    `, { cwd });
    assert.equal(plant.result.ok, true, plant.result.output);
    assert.equal(lstatSync(join(cwd, 'file-link')).isSymbolicLink(), true);

    // Any later run in the same directory: the engine hands it over again.
    const second = await runNode(`
      import { readFileSync } from 'node:fs';
      try { console.log(readFileSync('file-link', 'utf8')); } catch (e) { console.log('unreadable ' + e.code); }
    `, { cwd });
    assert.equal(second.result.ok, true, second.result.output);
    assert.doesNotMatch(second.result.output, /host only/);
    assert.deepEqual([host.dir, host.file, host.inner, host.nested].map(owner), before);
    assert.equal(owner(host.file).uid, 0);
    // The link itself is the sandbox's, and was handed over, not followed.
    assert.equal(lstatSync(join(cwd, 'file-link')).uid, 65534);
  });

  test('files the engine wrote are handed over so the code can change them', async () => {
    const cwd = scratchDir();
    writeFileSync(join(cwd, 'engine-wrote.txt'), 'before', { mode: 0o644 });
    const { result } = await runNode(`
      import { writeFileSync } from 'node:fs';
      writeFileSync('engine-wrote.txt', 'after');
    `, { cwd });
    assert.equal(result.ok, true, result.output);
    assert.equal(readFileSync(join(cwd, 'engine-wrote.txt'), 'utf8'), 'after');
  });
});

describe('sandbox copies of a project', () => {
  test("are made from HEAD outside the checkout, with the user's changes when asked", async () => {
    const fixture = makeRepo({ 'src/app.js': 'export const answer = 1;\n', 'README.md': 'hello\n' });
    try {
      writeFileSync(join(fixture.repo, 'src/app.js'), 'export const answer = 2;\n');
      writeFileSync(join(fixture.repo, 'notes.txt'), 'untracked\n');
      const statusBefore = fixture.git(['status', '--porcelain']);

      const runId = randomUUID();
      const clean = await createSandbox({ runId, repoPath: fixture.repo });
      assert.equal(clean.root, join(sandboxesDir(), runId));
      assert.ok(!clean.root.startsWith(fixture.repo));
      assert.equal(readFileSync(join(clean.worktree, 'src/app.js'), 'utf8'), 'export const answer = 1;\n');
      assert.equal(existsSync(join(clean.worktree, 'notes.txt')), false);
      // The repository database sits beside the worktree, not in it.
      assert.ok(existsSync(join(clean.gitDir, 'HEAD')));
      assert.ok(!clean.gitDir.startsWith(clean.worktree));
      await removeSandbox(clean);
      assert.equal(existsSync(clean.root), false);

      const carried = await createSandbox({ runId: randomUUID(), repoPath: fixture.repo, carryUncommitted: true });
      assert.equal(readFileSync(join(carried.worktree, 'src/app.js'), 'utf8'), 'export const answer = 2;\n');
      assert.equal(readFileSync(join(carried.worktree, 'notes.txt'), 'utf8'), 'untracked\n');
      assert.deepEqual(carried.carried, { diff: true, untracked: 1 });
      await removeSandbox(carried);

      // The user's checkout is exactly as it was.
      assert.equal(fixture.git(['status', '--porcelain']), statusBefore);
      assert.equal(fixture.git(['worktree', 'list']).trim().split('\n').length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('do not point back at the user repository', async () => {
    const fixture = makeRepo({ 'a.txt': 'a\n' });
    try {
      const sandbox = await createSandbox({ runId: randomUUID(), repoPath: fixture.repo });
      const config = readFileSync(join(sandbox.gitDir, 'config'), 'utf8');
      assert.doesNotMatch(config, /remote "origin"/);
      const hooks = join(sandbox.gitDir, 'hooks');
      assert.deepEqual(existsSync(hooks) ? readdirSync(hooks) : [], []);
      await removeSandbox(sandbox);
    } finally {
      fixture.cleanup();
    }
  });

  test('refuse a data directory inside the checkout or under .claude', async () => {
    const fixture = makeRepo({ 'a.txt': 'a\n' });
    const previous = process.env.SCOPE_DATA_DIR;
    try {
      process.env.SCOPE_DATA_DIR = join(fixture.repo, '.scope');
      await assert.rejects(createSandbox({ runId: 'r1', repoPath: fixture.repo }), { code: 'unsafe_sandbox_path' });
      assert.equal(existsSync(join(fixture.repo, '.scope')), false);

      const claude = join(tempDir('cfg'), '.claude', 'scope');
      process.env.SCOPE_DATA_DIR = claude;
      await assert.rejects(createSandbox({ runId: 'r1', repoPath: fixture.repo }), { code: 'unsafe_sandbox_path' });
      assert.equal(existsSync(claude), false);
    } finally {
      process.env.SCOPE_DATA_DIR = previous;
      fixture.cleanup();
    }
  });

  test('refuse bad run ids, non-repositories and repositories with no commit, leaving nothing behind', async () => {
    const fixture = makeRepo({ 'a.txt': 'a\n' });
    const listing = () => (existsSync(sandboxesDir()) ? readdirSync(sandboxesDir()) : []);
    const before = listing();
    try {
      await assert.rejects(createSandbox({ runId: '../escape', repoPath: fixture.repo }), { code: 'invalid_sandbox_request' });
      await assert.rejects(createSandbox({ runId: 'r-plain', repoPath: tempDir('plain') }), { code: 'not_a_repository' });
      const empty = join(tempDir('empty'), 'repo');
      mkdirSync(empty);
      fixture.git(['init', '--quiet', empty]);
      await assert.rejects(createSandbox({ runId: 'r-empty', repoPath: empty }), { code: 'no_commits' });
      assert.deepEqual(listing(), before);
    } finally {
      fixture.cleanup();
    }
  });

  test('refuse a second sandbox for the same run without touching the first', async () => {
    const fixture = makeRepo({ 'a.txt': 'a\n' });
    try {
      const runId = randomUUID();
      const first = await createSandbox({ runId, repoPath: fixture.repo });
      writeFileSync(join(first.worktree, 'work.txt'), 'in progress');
      await assert.rejects(createSandbox({ runId, repoPath: fixture.repo }), { code: 'sandbox_exists' });
      assert.equal(readFileSync(join(first.worktree, 'work.txt'), 'utf8'), 'in progress');
      await removeSandbox(first);
    } finally {
      fixture.cleanup();
    }
  });

  test('are removed when the work fails, even after the sandbox locked its files', { skip: !linux && 'needs the OS sandbox' }, async () => {
    const fixture = makeRepo({ 'a.txt': 'a\n' });
    let root;
    try {
      await assert.rejects(
        withSandbox({ runId: randomUUID(), repoPath: fixture.repo }, async (sandbox) => {
          root = sandbox.root;
          // Code in the sandbox makes a directory nobody may enter.
          const result = await runSandboxed({
            command: 'node',
            args: ['-e', 'const fs = require("fs"); fs.mkdirSync("locked/deep", { recursive: true }); fs.writeFileSync("locked/deep/f", "x"); fs.chmodSync("locked/deep", 0); fs.chmodSync("locked", 0);'],
            cwd: sandbox.scratch,
          });
          assert.equal(result.ok, true, result.output);
          throw new Error('the step failed');
        }),
        /the step failed/
      );
      assert.ok(root);
      assert.equal(existsSync(root), false);
    } finally {
      fixture.cleanup();
    }
  });

  test('removal refuses anything that is not a sandbox directory', async () => {
    const precious = tempDir('precious');
    writeFileSync(join(precious, 'keep.txt'), 'keep');
    await assert.rejects(removeSandbox(precious), { code: 'unsafe_sandbox_path' });
    await assert.rejects(removeSandbox(join(sandboxesDir(), '..')), { code: 'unsafe_sandbox_path' });
    assert.equal(readFileSync(join(precious, 'keep.txt'), 'utf8'), 'keep');
  });
});
