import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchSandbox, removeSandbox } from '../../workspace/sandbox/checkout.js';
import { runSandboxed, sandboxStatus } from '../../workspace/sandbox/run.js';

// Every line of Python the physics plug-in runs goes through here, and here
// only through the OS sandbox (runSandboxed): no network, a clear
// environment, nothing writable but a private directory, and CPU, memory and
// wall-clock limits. There is no unsandboxed fallback. Without a sandbox,
// without python3, or without NumPy, SciPy and Pint, the toolchain is
// reported unavailable and nothing runs.

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS = readFileSync(join(here, 'harness.py'), 'utf8');
const MARK = '@@physics-result@@';

export const PYTHON_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  // SciPy's import alone maps a few hundred megabytes of address space.
  memoryMb: 1024,
  maxOutput: 256 * 1024,
});
// A failed probe is retried after this long, so installing the packages
// does not need an engine restart; a successful one is kept.
const RETRY_FAILED_MS = 30_000;

export class PhysicsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export const defaultSandbox = Object.freeze({ status: sandboxStatus, run: runSandboxed });

// The interpreter can be pointed at a virtual environment that holds the
// packages; its prefix is mounted read-only by the sandbox.
export function defaultPython(env = process.env) {
  return env.PHYSICS_PYTHON || 'python3';
}

function parseHarnessOutput(output, nonce) {
  const marker = `${MARK}${nonce} `;
  const at = output.lastIndexOf(marker);
  if (at === -1) return null;
  const line = output.slice(at + marker.length).split('\n')[0];
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function createPythonRunner({ sandbox = defaultSandbox, python = defaultPython(), now = Date.now } = {}) {
  let cached = null;
  let inflight = null;

  // One sandboxed run of the harness. The job and the harness are written to
  // a fresh directory inside the run's scratch space (or a scratch sandbox
  // made for this call), which is the only writable path, and removed after.
  async function invoke(job, { ctx = {}, timeoutMs = PYTHON_LIMITS.timeoutMs } = {}) {
    const own = ctx.sandbox?.scratch ? null : await createScratchSandbox();
    const scratch = ctx.sandbox?.scratch ?? own.scratch;
    const dir = join(scratch, `physics-${randomUUID()}`);
    const nonce = randomUUID();
    try {
      await mkdir(dir, { mode: 0o755 });
      await writeFile(join(dir, 'harness.py'), HARNESS, { mode: 0o644 });
      await writeFile(join(dir, 'job.json'), JSON.stringify({ ...job, nonce }), { mode: 0o644 });
      const result = await sandbox.run({
        command: python,
        // -I: no PYTHONPATH, no user site-packages, no script directory on
        // the path; -B: no bytecode written.
        args: ['-I', '-B', join(dir, 'harness.py'), join(dir, 'job.json')],
        cwd: dir,
        writable: [dir],
        readOnly: [],
        protect: ctx.localPath ? [ctx.localPath] : [],
        env: { OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', MPLBACKEND: 'Agg' },
        timeoutMs,
        memoryMb: PYTHON_LIMITS.memoryMb,
        cpuSeconds: Math.max(5, Math.ceil(timeoutMs / 1000)),
        maxOutput: PYTHON_LIMITS.maxOutput,
        signal: ctx.signal,
      });
      const payload = parseHarnessOutput(result.output ?? '', nonce);
      if (!payload) {
        const tail = String(result.output ?? '').slice(-500);
        if (result.timedOut || result.limit) {
          throw new PhysicsError('python_limit', `the computation stopped at the ${result.limit ?? 'time'} limit`, { limit: result.limit ?? 'timeout', tail });
        }
        throw new PhysicsError('python_failed', `python exited ${result.exitCode ?? result.signal} without a result${tail ? `: ${tail}` : ''}`, { tail });
      }
      return payload;
    } finally {
      if (own) await removeSandbox(own).catch(() => {});
      else await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Whether Python, NumPy, SciPy and Pint can run here, checked by running
  // them in the sandbox: a host python3 with the packages proves nothing
  // about what the sandbox can see.
  async function availability({ ctx = {} } = {}) {
    if (cached && (cached.state.available || now() - cached.at < RETRY_FAILED_MS)) return cached.state;
    // Concurrent callers share one probe.
    inflight ??= probe(ctx).then((state) => {
      cached = { state, at: now() };
      inflight = null;
      return state;
    });
    return inflight;
  }

  async function probe(ctx) {
    try {
      const payload = await invoke({ mode: 'probe' }, { ctx: { signal: ctx.signal }, timeoutMs: 60_000 });
      if (!payload.ok) {
        const missing = Array.isArray(payload.missing) ? payload.missing : [];
        return { available: false, reason: missing.length ? `Python is missing ${missing.join(', ')}` : 'the Python probe failed', versions: payload.versions ?? null };
      }
      return { available: true, reason: null, versions: payload.versions ?? null };
    } catch (err) {
      if (err?.code === 'command_not_found') return { available: false, reason: `${python} is not installed`, versions: null };
      if (['sandbox_unavailable', 'interpreter_not_isolatable'].includes(err?.code)) return { available: false, reason: err.message, versions: null };
      return { available: false, reason: `the Python probe failed: ${String(err?.message ?? err).slice(0, 300)}`, versions: null };
    }
  }

  // Runs a job once the toolchain is known to be there; otherwise throws
  // `physics_unavailable` without running anything.
  async function run(job, options = {}) {
    const state = await availability(options);
    if (!state.available) throw new PhysicsError('physics_unavailable', `the physics toolchain is unavailable: ${state.reason}`, { reason: state.reason });
    return invoke(job, options);
  }

  return { availability, run, python };
}
