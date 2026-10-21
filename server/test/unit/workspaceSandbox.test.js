import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  assertSafeSandboxDir,
  buildBwrapArgs,
  buildChownArgs,
  createSandboxRunner,
  darwinProfile,
  dataDir,
  defaultDataDir,
} from '../../src/workspace/sandbox/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'scope-sandbox-unit-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('sandbox location', () => {
  test('follows each platform convention for app data', () => {
    assert.equal(defaultDataDir({ platform: 'linux', env: {}, home: '/home/u' }), '/home/u/.local/share/scope-studio');
    assert.equal(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/u' }), '/data/scope-studio');
    // The XDG spec says a relative value is invalid and must be ignored.
    assert.equal(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: 'rel' }, home: '/home/u' }), '/home/u/.local/share/scope-studio');
    assert.equal(defaultDataDir({ platform: 'darwin', env: {}, home: '/Users/u' }), '/Users/u/Library/Application Support/Scope Studio');
  });

  test('SCOPE_DATA_DIR overrides the default and must be absolute', () => {
    assert.equal(dataDir({ env: { SCOPE_DATA_DIR: '/srv/scope' } }), '/srv/scope');
    assert.throws(() => dataDir({ env: { SCOPE_DATA_DIR: 'relative/dir' } }), { code: 'unsafe_sandbox_path' });
  });

  test('refuses any path under a .claude directory', () => {
    assert.throws(() => assertSafeSandboxDir('/srv/.claude/sandboxes/run1'), { code: 'unsafe_sandbox_path' });
    assert.throws(() => assertSafeSandboxDir(join(scratch, '.claude', 'x')), { code: 'unsafe_sandbox_path' });
  });

  test('refuses a .claude directory reached through a symlink', () => {
    const hidden = join(scratch, '.claude');
    mkdirSync(hidden, { recursive: true });
    symlinkSync(hidden, join(scratch, 'innocent'));
    assert.throws(() => assertSafeSandboxDir(join(scratch, 'innocent', 'sandboxes', 'r1')), { code: 'unsafe_sandbox_path' });
  });

  test("refuses the user's checkout, inside or around it", () => {
    const repo = join(scratch, 'repo');
    mkdirSync(repo, { recursive: true });
    assert.throws(() => assertSafeSandboxDir(join(repo, 'sandboxes', 'r1'), { repoPath: repo }), { code: 'unsafe_sandbox_path' });
    assert.throws(() => assertSafeSandboxDir(scratch, { repoPath: repo }), { code: 'unsafe_sandbox_path' });
    assert.doesNotThrow(() => assertSafeSandboxDir(join(scratch, 'data', 'sandboxes', 'r1'), { repoPath: repo }));
  });
});

describe('bubblewrap arguments', () => {
  const base = {
    system: [{ type: 'bind', path: '/usr' }, { type: 'symlink', path: '/bin', target: 'usr/bin' }],
    readOnly: ['/opt/node'],
    writable: ['/data/sandboxes/r1/scratch'],
    cwd: '/data/sandboxes/r1/scratch',
    env: { PATH: '/usr/bin', HOME: '/tmp' },
    limits: { asBytes: 1024, cpuSeconds: 3, maxProcesses: 7, fsizeBytes: 2048, maxOpenFiles: 9 },
    prlimit: '/usr/bin/prlimit',
    command: '/usr/bin/python3',
    args: ['x.py'],
    tmpBytes: 4096,
  };

  const pairs = (argv, flag) => argv.flatMap((arg, i) => (arg === flag ? [[argv[i + 1], argv[i + 2]]] : []));

  test('isolates network, pids, ipc and the session, and dies with the engine', () => {
    const argv = buildBwrapArgs(base);
    for (const flag of ['--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-user', '--die-with-parent', '--new-session', '--clearenv']) {
      assert.ok(argv.includes(flag), flag);
    }
    // Everything before `--` is bubblewrap's; the command comes after it.
    assert.ok(argv.indexOf('--') > argv.indexOf('--clearenv'));
  });

  test('mounts only the system, the interpreter read-only and the sandbox directory writable', () => {
    const argv = buildBwrapArgs(base);
    assert.deepEqual(pairs(argv, '--bind'), [['/data/sandboxes/r1/scratch', '/data/sandboxes/r1/scratch']]);
    assert.deepEqual(pairs(argv, '--ro-bind').map(([from]) => from), ['/usr', '/opt/node']);
    assert.ok(!argv.some((arg) => arg.startsWith('/home')), 'no home directory is mounted');
    assert.deepEqual(pairs(argv, '--chdir')[0][0], '/data/sandboxes/r1/scratch');
    assert.equal(argv[argv.indexOf('--remount-ro') + 1], '/');
  });

  test('applies every resource limit through prlimit right before the command', () => {
    const argv = buildBwrapArgs(base);
    const at = argv.indexOf('/usr/bin/prlimit');
    assert.deepEqual(argv.slice(at), [
      '/usr/bin/prlimit', '--as=1024', '--cpu=3:4', '--nproc=7', '--fsize=2048', '--nofile=9', '--core=0', '--', '/usr/bin/python3', 'x.py',
    ]);
  });

  test('as root, runs without a user namespace and drops to an unprivileged uid', () => {
    const argv = buildBwrapArgs({ ...base, setpriv: '/usr/bin/setpriv', dropTo: 65534 });
    assert.ok(!argv.includes('--unshare-user'));
    const at = argv.indexOf('/usr/bin/setpriv');
    assert.ok(at > argv.indexOf('--'));
    assert.deepEqual(argv.slice(at + 1, at + 5), ['--reuid', '65534', '--regid', '65534']);
    assert.ok(argv.includes('--no-new-privs') && argv.includes('--bounding-set=-all'));
    assert.ok(argv.indexOf('/usr/bin/prlimit') > at, 'limits apply after the uid drop');
  });

  test('creates traversable mount points for paths outside the system mounts', () => {
    const argv = buildBwrapArgs({ ...base, setpriv: '/usr/bin/setpriv', dropTo: 65534 });
    const dirs = argv.flatMap((arg, i) => (arg === '--dir' ? [argv[i + 1]] : []));
    assert.deepEqual(dirs, ['/opt', '/data', '/data/sandboxes', '/data/sandboxes/r1']);
    assert.equal(argv[argv.indexOf('--dir') - 1], '0755');
  });
});

describe('macOS profile', () => {
  test('denies the network and every write outside the sandbox directory', () => {
    const profile = darwinProfile({ writable: ['/Users/u/Library/Application Support/Scope Studio/sandboxes/r1/scratch'], readOnly: ['/opt/node'], hidden: ['/Users/u', '/Users/u/code/project'] });
    const lines = profile.trim().split('\n');
    assert.equal(lines[0], '(version 1)');
    assert.ok(lines.includes('(deny network*)'));
    assert.ok(lines.includes('(deny file-write*)'));
    assert.ok(lines.includes('(allow file-write* (subpath "/Users/u/Library/Application Support/Scope Studio/sandboxes/r1/scratch"))'));
    assert.ok(lines.includes('(deny file-read* (subpath "/Users/u") (subpath "/Users/u/code/project"))'));
    // Last match wins in SBPL: the narrow allowances come after the denials.
    assert.ok(lines.indexOf('(deny file-write*)') < lines.findIndex((line) => line.startsWith('(allow file-write*')));
    assert.ok(lines.findIndex((line) => line.startsWith('(deny file-read*')) < lines.findIndex((line) => line.startsWith('(allow file-read*')));
  });

  test('escapes paths so a directory name cannot inject rules', () => {
    const profile = darwinProfile({ writable: ['/tmp/a") (allow network*) ("'] });
    assert.ok(profile.includes('(subpath "/tmp/a\\") (allow network*) (\\"")'));
    assert.ok(!profile.split('\n').includes('(allow network*)'));
  });
});

describe('refusing without a sandbox', () => {
  const request = { command: 'node', args: ['-e', '0'], cwd: scratch };

  test('a platform with no sandbox mechanism refuses instead of running unsandboxed', async () => {
    let looked = 0;
    const runner = createSandboxRunner({ platform: 'win32', find: () => (looked++, '/bin/true') });
    assert.equal((await runner.status()).available, false);
    await assert.rejects(runner.run(request), { code: 'sandbox_unavailable' });
    assert.equal(looked, 0, 'nothing was even looked up to run');
  });

  test('Linux without bubblewrap refuses', async () => {
    const runner = createSandboxRunner({ platform: 'linux', find: (name) => (name === 'bwrap' ? null : `/usr/bin/${name}`), euid: 1000 });
    const status = await runner.status();
    assert.equal(status.available, false);
    assert.match(status.reason, /bwrap/);
    await assert.rejects(runner.run(request), { code: 'sandbox_unavailable' });
  });

  test('Linux as root without setpriv refuses, since limits could not apply', async () => {
    const runner = createSandboxRunner({ platform: 'linux', find: (name) => (name === 'setpriv' ? null : `/usr/bin/${name}`), euid: 0 });
    assert.match((await runner.status()).reason, /setpriv/);
  });

  test('bubblewrap that cannot start a sandbox refuses', async () => {
    // `false` stands in for a bubblewrap whose user namespaces are blocked.
    const runner = createSandboxRunner({ platform: 'linux', find: (name) => (name === 'bwrap' ? '/usr/bin/false' : `/usr/bin/${name}`), euid: 1000 });
    assert.equal((await runner.status()).available, false);
    await assert.rejects(runner.run(request), { code: 'sandbox_unavailable' });
  });

  test('macOS without sandbox-exec refuses', async () => {
    const runner = createSandboxRunner({ platform: 'darwin', find: () => null });
    await assert.rejects(runner.run(request), { code: 'sandbox_unavailable' });
  });

  test('Linux as root without find or chown refuses, since files could not be handed over safely', async () => {
    for (const tool of ['find', 'chown']) {
      const runner = createSandboxRunner({ platform: 'linux', find: (name) => (name === tool ? null : `/usr/bin/${name}`), euid: 0 });
      assert.match((await runner.status()).reason, new RegExp(tool));
    }
  });

  test('a failed probe is retried after a while; a successful one is kept', async () => {
    let clock = 0;
    let bwrap = '/usr/bin/false';
    let probes = 0;
    const find = (name) => {
      if (name === 'bwrap') probes++;
      return name === 'bwrap' ? bwrap : `/usr/bin/${name}`;
    };
    const runner = createSandboxRunner({ platform: 'linux', find, euid: 1000, now: () => clock, retryFailedMs: 1_000 });
    assert.equal((await runner.status()).available, false);
    assert.equal((await runner.status()).available, false);
    assert.equal(probes, 1, 'a failure is not re-probed straight away');
    bwrap = '/usr/bin/true';
    clock = 1_000;
    assert.equal((await runner.status()).available, true);
    assert.equal(probes, 2);
    clock = 10_000_000;
    bwrap = '/usr/bin/false';
    assert.equal((await runner.status()).available, true);
    assert.equal(probes, 2, 'a success is kept');
  });
});

describe('handing the sandbox directory to the unprivileged uid', () => {
  const system = [{ type: 'bind', path: '/usr' }, { type: 'symlink', path: '/bin', target: 'usr/bin' }];
  const argv = buildChownArgs({ system, dir: '/data/sandboxes/r1/worktree', find: '/usr/bin/find', chown: '/usr/bin/chown', id: 65534 });
  const command = argv.slice(argv.indexOf('--') + 1);

  test('runs in a sandbox where only that directory and the read-only system exist', () => {
    assert.deepEqual(argv.slice(0, 7), ['--unshare-ipc', '--unshare-pid', '--unshare-net', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent', '--new-session']);
    const binds = [];
    for (let i = 0; i < argv.indexOf('--'); i++) if (argv[i] === '--bind' || argv[i] === '--ro-bind') binds.push([argv[i], argv[i + 1]]);
    assert.deepEqual(binds, [['--ro-bind', '/usr'], ['--bind', '/data/sandboxes/r1/worktree']]);
    assert.ok(argv.indexOf('--remount-ro') > argv.indexOf('--bind'));
    assert.ok(argv.includes('--clearenv'));
  });

  test('keeps only the capabilities a chown needs', () => {
    const before = argv.slice(0, argv.indexOf('--'));
    assert.deepEqual(before.slice(before.indexOf('--cap-drop'), before.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
    const added = before.flatMap((arg, i) => (arg === '--cap-add' ? [before[i + 1]] : []));
    assert.deepEqual(added.sort(), ['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_DAC_READ_SEARCH', 'CAP_FOWNER']);
  });

  test('never follows a link and changes a link itself, not its target', () => {
    assert.deepEqual(command.slice(0, 3), ['/usr/bin/find', '-P', '/data/sandboxes/r1/worktree']);
    assert.ok(!command.includes('-L') && !command.includes('-H') && !command.includes('-follow'));
    assert.deepEqual(command.slice(-6), ['-exec', '/usr/bin/chown', '-h', '65534:65534', '{}', '+']);
    assert.ok(!command.includes('-R'));
  });
});
