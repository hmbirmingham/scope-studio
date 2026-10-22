import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchSandbox, removeSandbox } from '../../workspace/sandbox/checkout.js';
import { runSandboxed, sandboxStatus } from '../../workspace/sandbox/run.js';
import { CadError } from './errors.js';

// CadQuery (on the OCCT kernel) for what needs a real B-rep: STEP geometry,
// solid interference and parametric edits. It is Python, and it only ever
// runs inside the OS sandbox: every call copies its inputs, the driver and a
// request into a fresh scratch directory, runs the driver there with no
// network and nothing else writable, reads the answer and removes the
// directory. Without an OS sandbox, or without CadQuery, every call refuses
// with `tool_unavailable`; nothing falls back to running on the host.
//
// Which Python: CADQUERY_PYTHON names an interpreter that can import
// cadquery (a virtual environment made with `python3 -m venv --copies`, so
// the interpreter and its packages sit together under one prefix the sandbox
// can mount), else `python3`.

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(here, 'driver.py');
const MARKER = '@@SCOPE_CAD@@';

// OCCT maps several hundred megabytes of libraries; these limits leave room
// for real parts while still bounding a runaway script.
const LIMITS = { memoryMb: 4096, maxOutput: 400_000, maxProcesses: 64, maxFileMb: 256 };
const PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 300_000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_FILE_BYTES = 128 * 1024 * 1024;

export const defaultSandbox = Object.freeze({ status: sandboxStatus, run: runSandboxed });

function pythonFromEnv() {
  return process.env.CADQUERY_PYTHON || 'python3';
}

function lastAnswer(output) {
  const at = output.lastIndexOf(MARKER);
  if (at === -1) return null;
  const line = output.slice(at + MARKER.length).split('\n')[0];
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Reads a file the sandboxed process wrote, without following a symlink it
// may have planted in place of the file.
async function readOwnFile(path) {
  const stat = await lstat(path).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > MAX_OUTPUT_FILE_BYTES) throw new CadError('file_too_large', `${basename(path)} is larger than ${MAX_OUTPUT_FILE_BYTES} bytes`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function createCadQuery({ sandbox = defaultSandbox, python = pythonFromEnv, now = Date.now, retryFailedMs = 60_000 } = {}) {
  let probe = null;
  let probedAt = 0;
  let probeOk = false;

  // Runs the driver once in a fresh scratch directory. `inputs` are
  // `{ name, buffer }`; `collect` names files under the scratch directory to
  // read back before it is removed.
  async function invoke(request, { inputs = [], script = null, collect = [], timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    const scratch = await createScratchSandbox();
    try {
      const dir = scratch.scratch;
      await mkdir(join(dir, 'in'));
      await mkdir(join(dir, 'out'));
      const placed = [];
      for (const [index, input] of inputs.entries()) {
        if (input.buffer.length > MAX_INPUT_BYTES) throw new CadError('file_too_large', `${input.name} is larger than ${MAX_INPUT_BYTES} bytes`);
        // The file keeps its extension (the driver picks a reader by it) but
        // never its directory names.
        const path = join(dir, 'in', `${index}-${basename(input.name).replace(/[^A-Za-z0-9._-]/g, '_')}`);
        await writeFile(path, input.buffer, { mode: 0o644 });
        placed.push({ name: input.name, path });
      }
      const body = { ...request, inputs: placed };
      if (script != null) {
        body.script = join(dir, 'edit.py');
        await writeFile(body.script, script, { mode: 0o644 });
      }
      if (request.output) body.output = join(dir, 'out', request.output);
      const requestPath = join(dir, `request-${randomUUID()}.json`);
      await writeFile(requestPath, JSON.stringify(body), { mode: 0o644 });
      const driverPath = join(dir, 'driver.py');
      await writeFile(driverPath, await readFile(DRIVER), { mode: 0o644 });

      let result;
      try {
        result = await sandbox.run({
          command: python(),
          args: ['-I', driverPath, requestPath],
          cwd: dir,
          writable: [dir],
          timeoutMs,
          cpuSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
          signal,
          ...LIMITS,
        });
      } catch (err) {
        if (err?.code === 'sandbox_unavailable' || err?.code === 'command_not_found' || err?.code === 'interpreter_not_isolatable') {
          throw new CadError('tool_unavailable', `CadQuery cannot run here: ${err.message}`);
        }
        throw err;
      }
      const reply = lastAnswer(result.output ?? '');
      if (result.timedOut) throw new CadError('cadquery_timeout', `CadQuery did not finish within ${timeoutMs} ms`);
      if (result.limit && result.limit !== 'output') throw new CadError('cadquery_limit', `CadQuery hit the sandbox's ${result.limit} limit`);
      if (!reply) {
        throw new CadError('cadquery_failed', `CadQuery gave no answer (exit ${result.exitCode}): ${String(result.output ?? '').slice(-500)}`);
      }
      if (reply.error) throw new CadError(reply.error.code === 'cadquery_missing' ? 'tool_unavailable' : reply.error.code, reply.error.message);
      if (!result.ok) throw new CadError('cadquery_failed', `CadQuery exited ${result.exitCode}`);

      const files = {};
      for (const name of collect) files[name] = await readOwnFile(join(dir, name));
      return { reply, files };
    } finally {
      await removeSandbox(scratch).catch(() => {});
    }
  }

  // Whether CadQuery can run here, checked by running it in the sandbox. A
  // success is kept for the life of the process; a failure only briefly, so
  // installing CadQuery does not need a restart.
  async function status() {
    if (probe && (probeOk || now() - probedAt < retryFailedMs)) return probe;
    probedAt = now();
    probe = (async () => {
      let os;
      try {
        os = await sandbox.status();
      } catch (err) {
        os = { available: false, reason: err?.message ?? 'the sandbox probe failed' };
      }
      if (!os.available) return { available: false, version: null, reason: `no OS sandbox (${os.reason}), so CadQuery cannot run` };
      try {
        const { reply } = await invoke({ mode: 'probe' }, { timeoutMs: PROBE_TIMEOUT_MS });
        return { available: true, version: reply.version ?? null, reason: null };
      } catch (err) {
        return { available: false, version: null, reason: err.message };
      }
    })();
    const state = await probe;
    probeOk = state.available;
    return state;
  }

  async function requireAvailable() {
    const state = await status();
    if (!state.available) throw new CadError('tool_unavailable', `CadQuery is not available: ${state.reason}`);
  }

  return {
    status,

    // Geometry of STEP files: `files` are `{ name, buffer }`. With `mesh`,
    // each answer carries `meshBuffer`, a tessellated STL of the shape.
    async inspect(files, { mesh = false, signal, timeoutMs } = {}) {
      await requireAvailable();
      const collect = mesh ? files.map((_, index) => `out/mesh-${index}.stl`) : [];
      const { reply, files: out } = await invoke({ mode: 'inspect', mesh }, { inputs: files, collect, signal, timeoutMs });
      return reply.files.map((info, index) => ({ ...info, meshBuffer: mesh ? out[`out/mesh-${index}.stl`] : undefined }));
    },

    async interference(files, { withinFiles = false, tolerance, signal, timeoutMs } = {}) {
      await requireAvailable();
      const { reply } = await invoke({ mode: 'interference', withinFiles, ...(tolerance != null ? { tolerance } : {}) }, { inputs: files, signal, timeoutMs });
      return reply;
    },

    // Runs a model-written script that sets `result`; returns the exported
    // file and a tessellated mesh of it, plus what the driver measured. The
    // script runs in the same process as the driver, so what it reports is
    // only as trustworthy as the script: verifiers measure the file again in
    // a fresh run with no model-written code in it.
    async edit({ script, output, inputs = [], signal, timeoutMs }) {
      await requireAvailable();
      const { reply, files } = await invoke(
        { mode: 'edit', output },
        { inputs, script, collect: [`out/${output}`, 'out/mesh-result.stl'], signal, timeoutMs }
      );
      if (!files[`out/${output}`]) throw new CadError('no_result', 'the script ran but no part was exported');
      return { info: reply, file: files[`out/${output}`], mesh: files['out/mesh-result.stl'] };
    },
  };
}

export const defaultCadQuery = createCadQuery();
