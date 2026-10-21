import { execFile } from 'node:child_process';
import { constants, accessSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { chown, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { isInside, realpathLoose } from './paths.js';

// The OS sandbox that model-written code runs in (docs/architecture/
// agent-workspace.md, `run_generated_code`). Nothing here ever runs a command
// unsandboxed: if no mechanism is available the call is refused with
// `sandbox_unavailable`, and the caller decides what to tell the user.
//
// Linux uses bubblewrap: fresh network, pid, ipc and uts namespaces (so the
// only network is a private loopback), the system directories read-only, the
// interpreter's install directory read-only, the sandbox directory the only
// writable host path, and nothing else of the host's filesystem visible, so
// $HOME and the user's checkout simply do not exist inside. Resource limits
// come from prlimit (util-linux), run inside the sandbox right before the
// command. macOS uses sandbox-exec with a generated profile.
//
// Every process is started with execFile and a fixed argument list; the
// command and its arguments are never parsed by a shell.

export const DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  memoryMb: 512,
  cpuSeconds: 10,
  maxOutput: 20_000,
  maxProcesses: 64,
  maxFileMb: 64,
  maxOpenFiles: 256,
  tmpMb: 64,
});

// V8 reserves several hundred megabytes of address space up front (code
// range, pointer cage) that it never touches. RLIMIT_AS counts that
// reservation, so a Node process gets this much on top of its memory limit,
// and its heap is held to the memory limit with --max-old-space-size instead.
const NODE_RESERVE_MB = 2048;
const NODE_COMMANDS = new Set(['node', 'npm', 'npx']);

// When the engine runs as root (containers), RLIMIT_NPROC does not apply to
// uid 0, so a fork bomb would be unbounded. The sandboxed process is moved to
// the conventional unprivileged `nobody` uid instead.
const UNPRIVILEGED_ID = 65534;

const SYSTEM_DIRS = ['/usr', '/lib', '/lib64', '/lib32', '/libx32', '/bin', '/sbin'];
const SAFE_ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
// Keys the sandbox sets itself; a caller cannot point them elsewhere.
const RESERVED_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH']);

const SIGXCPU_EXIT = 128 + 24;
const SIGXFSZ_EXIT = 128 + 25;

export class SandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Looks a program up the way a shell would, without a shell: the given PATH
// first, then the standard system directories (a server started from a
// launcher often has a thin PATH).
export function findExecutable(name, { path = process.env.PATH ?? '' } = {}) {
  if (isAbsolute(name)) return isExecutable(name) ? name : null;
  if (name.includes('/') || name.includes('\\')) return null;
  const dirs = [...path.split(delimiter).filter(Boolean), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// The install directory an interpreter needs mounted to run: `<prefix>/bin/x`
// gives `<prefix>`. Anything under /usr is already mounted.
function installPrefix(path) {
  const dir = dirname(path);
  return basename(dir) === 'bin' ? dirname(dir) : dir;
}

function commandMounts(unresolved, real, { protect }) {
  const mounts = [];
  for (const prefix of [installPrefix(unresolved), installPrefix(real)]) {
    if (SYSTEM_DIRS.some((dir) => isInside(dir, prefix))) continue;
    // Mounting the user's home directory or checkout to reach an interpreter
    // would hand the sandbox exactly what it must not see.
    if (prefix === '/' || protect.some((path) => isInside(prefix, path))) {
      throw new SandboxError('interpreter_not_isolatable', `cannot mount ${prefix} into the sandbox without exposing a protected directory`);
    }
    if (!mounts.some((mount) => isInside(mount, prefix))) mounts.push(prefix);
  }
  return mounts;
}

function systemEntries() {
  const entries = [];
  for (const path of SYSTEM_DIRS) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) entries.push({ type: 'symlink', path, target: readlinkSync(path) });
      else if (stat.isDirectory()) entries.push({ type: 'bind', path });
    } catch {
      // Not every distribution has every directory.
    }
  }
  return entries;
}

function ancestors(path) {
  const list = [];
  for (let dir = dirname(path); dir !== '/' && dir !== dirname(dir); dir = dirname(dir)) list.unshift(dir);
  return list;
}

// The bubblewrap argument list. Pure, so the exact isolation it asks for is
// unit-tested without starting anything.
export function buildBwrapArgs({
  system,
  readOnly = [],
  writable,
  cwd,
  env,
  limits,
  prlimit,
  setpriv = null,
  dropTo = null,
  command,
  args = [],
  tmpBytes,
}) {
  const argv = [
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-uts',
    '--unshare-cgroup-try',
  ];
  // Root runs bubblewrap without a user namespace and drops to an
  // unprivileged uid inside; anyone else gets a user namespace.
  if (dropTo == null) argv.push('--unshare-user');
  argv.push('--die-with-parent', '--new-session');

  const mounted = [];
  const created = new Set();
  const covered = (path) => mounted.some((mount) => isInside(mount, path));
  const makeParents = (path) => {
    for (const dir of ancestors(path)) {
      if (created.has(dir) || covered(dir)) continue;
      // Explicit modes: as root, bubblewrap would otherwise create mount
      // points that the unprivileged uid cannot traverse.
      argv.push('--perms', '0755', '--dir', dir);
      created.add(dir);
    }
  };

  for (const entry of system) {
    if (entry.type === 'symlink') argv.push('--symlink', entry.target, entry.path);
    else {
      argv.push('--ro-bind', entry.path, entry.path);
      mounted.push(entry.path);
    }
  }
  argv.push('--proc', '/proc', '--dev', '/dev', '--size', String(tmpBytes), '--tmpfs', '/tmp');
  // /tmp is a fresh tmpfs, so mount points beneath it are created like any
  // other; /proc and /dev are not places a mount point should go.
  mounted.push('/proc', '/dev');

  for (const path of readOnly) {
    if (covered(path)) continue;
    makeParents(path);
    argv.push('--ro-bind', path, path);
    mounted.push(path);
  }
  for (const path of writable) {
    makeParents(path);
    argv.push('--bind', path, path);
    mounted.push(path);
  }

  // bubblewrap builds the new root on a tmpfs that the sandbox could
  // otherwise write to; only the mounts above (and /tmp) stay writable.
  argv.push('--remount-ro', '/');
  argv.push('--chdir', cwd, '--clearenv');
  for (const [key, value] of Object.entries(env)) argv.push('--setenv', key, value);

  if (dropTo != null) argv.push('--cap-add', 'CAP_SETUID', '--cap-add', 'CAP_SETGID');
  argv.push('--');
  if (dropTo != null) {
    argv.push(
      setpriv,
      '--reuid', String(dropTo),
      '--regid', String(dropTo),
      '--clear-groups',
      '--inh-caps=-all',
      '--bounding-set=-all',
      '--no-new-privs',
      '--'
    );
  }
  argv.push(
    prlimit,
    `--as=${limits.asBytes}`,
    `--cpu=${limits.cpuSeconds}:${limits.cpuSeconds + 1}`,
    `--nproc=${limits.maxProcesses}`,
    `--fsize=${limits.fsizeBytes}`,
    `--nofile=${limits.maxOpenFiles}`,
    '--core=0',
    '--',
    command,
    ...args
  );
  return argv;
}

function sbplString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// The macOS sandbox profile. In SBPL the last matching rule wins, so the
// broad denials come first and the narrow allowances after them.
export function darwinProfile({ writable, readOnly = [], hidden = [] }) {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((path) => `(subpath ${sbplString(path)})`).join(' ')})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
  ];
  if (hidden.length) {
    lines.push(`(deny file-read* ${hidden.map((path) => `(subpath ${sbplString(path)})`).join(' ')})`);
    // The sandbox directory and the interpreter may live under a hidden
    // directory (the data directory is under the home directory on macOS).
    lines.push(`(allow file-read* ${[...writable, ...readOnly].map((path) => `(subpath ${sbplString(path)})`).join(' ')})`);
  }
  return `${lines.join('\n')}\n`;
}

async function chownTree(path, id) {
  const stat = await lstat(path);
  await chown(path, id, id).catch(() => {});
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of await readdir(path)) await chownTree(join(path, entry), id);
  }
}

function realDir(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new SandboxError('invalid_sandbox_request', `${label} must be an absolute path`);
  try {
    const real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
    return real;
  } catch {
    throw new SandboxError('invalid_sandbox_request', `${label} ${path} is not a directory`);
  }
}

function positive(value, fallback, label) {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new SandboxError('invalid_sandbox_request', `${label} must be a positive number`);
  return Math.floor(value);
}

function execFileResult(file, argv, { timeoutMs, maxOutput, env, signal }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = execFile(
      file,
      argv,
      { env, signal, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: maxOutput, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const outputLimited = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const aborted = err?.name === 'AbortError';
        const timedOut = Boolean(err?.killed) && !outputLimited && !aborted && durationMs >= timeoutMs;
        let exitCode = 0;
        if (err) exitCode = typeof err.code === 'number' ? err.code : null;
        resolvePromise({
          exitCode,
          signal: err?.signal ?? null,
          timedOut,
          aborted,
          outputLimited,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          durationMs,
          spawnError: err && !outputLimited && !aborted && !err.killed && typeof err.code === 'string' ? err.code : null,
        });
      }
    );
    // Nothing is ever written to the sandboxed process; closing stdin makes a
    // read return end-of-file instead of hanging until the wall clock.
    child.stdin?.end();
  });
}

function capOutput(result, maxOutput) {
  let combined = `${result.stdout}${result.stderr}`;
  let truncated = result.outputLimited;
  if (combined.length > maxOutput) {
    combined = combined.slice(0, maxOutput);
    truncated = true;
  }
  return { output: truncated ? `${combined}\n… output truncated` : combined, truncated };
}

function limitHit(result) {
  if (result.aborted) return 'aborted';
  if (result.timedOut) return 'timeout';
  if (result.outputLimited) return 'output';
  if (result.exitCode === SIGXCPU_EXIT || result.signal === 'SIGXCPU') return 'cpu';
  if (result.exitCode === SIGXFSZ_EXIT || result.signal === 'SIGXFSZ') return 'file_size';
  return null;
}

export function createSandboxRunner({
  platform = process.platform,
  find = findExecutable,
  euid = typeof process.geteuid === 'function' ? process.geteuid() : null,
  home = homedir(),
} = {}) {
  let probe = null;

  function linuxTools() {
    const tools = { bwrap: find('bwrap'), prlimit: find('prlimit'), setpriv: euid === 0 ? find('setpriv') : null };
    const missing = Object.entries(tools)
      .filter(([name, path]) => !path && (name !== 'setpriv' || euid === 0))
      .map(([name]) => name);
    return { tools, missing };
  }

  async function prepare(options) {
    const command = options.command;
    if (typeof command !== 'string' || !command) throw new SandboxError('invalid_sandbox_request', 'command is required');
    const args = options.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) {
      throw new SandboxError('invalid_sandbox_request', 'args must be a list of strings');
    }
    const cwd = realDir(options.cwd, 'cwd');
    const writable = (options.writable ?? [options.cwd]).map((path) => realDir(path, 'writable'));
    const readOnly = (options.readOnly ?? []).map((path) => realDir(path, 'readOnly'));
    if (![...writable, ...readOnly].some((path) => isInside(path, cwd))) {
      throw new SandboxError('invalid_sandbox_request', 'cwd must be inside a directory mounted into the sandbox');
    }
    // Protected directories (the user's checkout) may not be mounted at all,
    // nor anything inside or around them. The home directory may not be
    // mounted or reached through an ancestor, but the data directory is
    // usually inside it, so a mount below home is fine.
    const checkouts = (options.protect ?? []).map((path) => realpathLoose(path));
    const protect = [realpathLoose(home), ...checkouts];
    for (const path of [...writable, ...readOnly]) {
      if (protect.some((guarded) => isInside(path, guarded)) || checkouts.some((guarded) => isInside(guarded, path))) {
        throw new SandboxError('invalid_sandbox_request', `${path} would expose a protected directory`);
      }
    }

    const unresolved = find(command);
    if (!unresolved) throw new SandboxError('command_not_found', `${command} is not installed`);
    const real = realpathSync(unresolved);
    const mounts = commandMounts(unresolved, real, { protect });
    const isNode = NODE_COMMANDS.has(basename(command));
    // npm's launcher is `#!/usr/bin/env node`, so the node it runs must be
    // mounted and on PATH too: the one this engine runs on.
    if (isNode && basename(command) !== 'node') {
      for (const mount of commandMounts(process.execPath, realpathSync(process.execPath), { protect })) {
        if (!mounts.some((existing) => isInside(existing, mount))) mounts.push(mount);
      }
    }

    const memoryMb = positive(options.memoryMb, DEFAULTS.memoryMb, 'memoryMb');
    const limits = {
      asBytes: (memoryMb + (isNode ? NODE_RESERVE_MB : 0)) * 1024 * 1024,
      cpuSeconds: positive(options.cpuSeconds, DEFAULTS.cpuSeconds, 'cpuSeconds'),
      maxProcesses: positive(options.maxProcesses, DEFAULTS.maxProcesses, 'maxProcesses'),
      fsizeBytes: positive(options.maxFileMb, DEFAULTS.maxFileMb, 'maxFileMb') * 1024 * 1024,
      maxOpenFiles: DEFAULTS.maxOpenFiles,
    };

    const env = {};
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!SAFE_ENV_KEY.test(key) || RESERVED_ENV.has(key) || typeof value !== 'string') {
        throw new SandboxError('invalid_sandbox_request', `environment variable ${key} is not allowed`);
      }
      env[key] = value;
    }
    const binDirs = mounts.map((mount) => join(mount, 'bin')).filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
    Object.assign(env, {
      PATH: [...binDirs, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
      HOME: '/tmp',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
    });
    if (isNode) {
      env.NODE_OPTIONS = `--max-old-space-size=${memoryMb}`;
      // npm would otherwise try the network for an update check and write its
      // cache and logs under HOME.
      env.npm_config_update_notifier = 'false';
      env.npm_config_cache = '/tmp/.npm';
      env.npm_config_audit = 'false';
      env.npm_config_fund = 'false';
    }

    return {
      // The resolved path: a symlink such as /usr/bin/python3 may point
      // through /etc/alternatives, which is not mounted inside.
      command: real,
      args,
      cwd,
      writable,
      readOnly: [...mounts, ...readOnly],
      env,
      limits,
      protect,
      timeoutMs: positive(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs'),
      maxOutput: positive(options.maxOutput, DEFAULTS.maxOutput, 'maxOutput'),
      signal: options.signal,
    };
  }

  function linuxArgv(plan, tools) {
    return buildBwrapArgs({
      system: systemEntries(),
      readOnly: plan.readOnly,
      writable: plan.writable,
      cwd: plan.cwd,
      env: plan.env,
      limits: plan.limits,
      prlimit: tools.prlimit,
      setpriv: tools.setpriv,
      dropTo: euid === 0 ? UNPRIVILEGED_ID : null,
      command: plan.command,
      args: plan.args,
      tmpBytes: DEFAULTS.tmpMb * 1024 * 1024,
    });
  }

  // Whether a sandbox can be made here, checked once by actually starting
  // one: bubblewrap can be installed and still be unusable (user namespaces
  // disabled by sysctl or AppArmor).
  async function status() {
    if (probe) return probe;
    probe = (async () => {
      if (platform === 'linux') {
        const { tools, missing } = linuxTools();
        if (missing.length) return { available: false, mechanism: null, reason: `missing ${missing.join(', ')}` };
        const truePath = find('true');
        if (!truePath) return { available: false, mechanism: null, reason: 'missing true' };
        const argv = buildBwrapArgs({
          system: systemEntries(),
          writable: [],
          cwd: '/',
          env: { PATH: '/usr/bin:/bin' },
          limits: { asBytes: 256 * 1024 * 1024, cpuSeconds: 5, maxProcesses: 16, fsizeBytes: 1024 * 1024, maxOpenFiles: 64 },
          prlimit: tools.prlimit,
          setpriv: tools.setpriv,
          dropTo: euid === 0 ? UNPRIVILEGED_ID : null,
          command: truePath,
          tmpBytes: 1024 * 1024,
        });
        const result = await execFileResult(tools.bwrap, argv, { timeoutMs: 10_000, maxOutput: 4096, env: {} });
        if (result.exitCode !== 0) {
          return { available: false, mechanism: null, reason: `bubblewrap could not start a sandbox: ${`${result.stdout}${result.stderr}`.trim().slice(0, 300)}` };
        }
        return { available: true, mechanism: 'bwrap', reason: null };
      }
      if (platform === 'darwin') {
        if (find('/usr/bin/sandbox-exec')) return { available: true, mechanism: 'sandbox-exec', reason: null };
        return { available: false, mechanism: null, reason: 'missing sandbox-exec' };
      }
      return { available: false, mechanism: null, reason: `no sandbox mechanism on ${platform}` };
    })();
    return probe;
  }

  async function run(options = {}) {
    const state = await status();
    if (!state.available) throw new SandboxError('sandbox_unavailable', `no OS sandbox is available (${state.reason}); refusing to run unsandboxed`);
    const plan = await prepare(options);

    let file;
    let argv;
    if (state.mechanism === 'bwrap') {
      const { tools } = linuxTools();
      // The unprivileged uid must be able to write the sandbox directory.
      if (euid === 0) for (const path of plan.writable) await chownTree(path, UNPRIVILEGED_ID);
      file = tools.bwrap;
      argv = linuxArgv(plan, tools);
    } else {
      // macOS has no prlimit; the wall clock and output caps still apply, and
      // the profile denies the network and writes outside the sandbox.
      file = '/usr/bin/sandbox-exec';
      const profile = darwinProfile({ writable: plan.writable, readOnly: plan.readOnly, hidden: plan.protect });
      argv = ['-p', profile, plan.command, ...plan.args];
      plan.env.TMPDIR = plan.writable[0];
      plan.env.HOME = plan.writable[0];
    }

    const result = await execFileResult(file, argv, {
      timeoutMs: plan.timeoutMs,
      maxOutput: plan.maxOutput,
      env: state.mechanism === 'bwrap' ? {} : plan.env,
      signal: plan.signal,
    });
    if (state.mechanism !== 'bwrap' && result.spawnError) {
      throw new SandboxError('sandbox_unavailable', `the sandbox could not start (${result.spawnError})`);
    }
    const { output, truncated } = capOutput(result, plan.maxOutput);
    return {
      ok: result.exitCode === 0 && !result.timedOut && !result.outputLimited && !result.aborted,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      limit: limitHit(result),
      output: output.trim(),
      truncated,
      durationMs: result.durationMs,
      mechanism: state.mechanism,
    };
  }

  return { status, run };
}

const defaultRunner = createSandboxRunner();

export function sandboxStatus() {
  return defaultRunner.status();
}

// runSandboxed({ command, args, cwd, timeoutMs, memoryMb, cpuSeconds,
// maxOutput, writable?, readOnly?, protect?, env?, maxProcesses?, maxFileMb?,
// signal? }). `writable` defaults to
// [cwd]; `protect` names directories (the user's checkout) that must never be
// mounted. Throws SandboxError('sandbox_unavailable') rather than run
// anything unsandboxed.
export function runSandboxed(options) {
  return defaultRunner.run(options);
}
