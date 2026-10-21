import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Recorded CadQuery answers, so the CAD tests run the same assertions on a
// machine without CadQuery. `recordingSandbox` wraps the real OS sandbox and
// keeps what the driver printed and the files it wrote; `replaySandbox`
// stands in for the OS sandbox and plays them back, writing the recorded
// files where the driver would have. Everything between (cadquery.js, the
// plug-in, the verifiers) runs for real either way.
//
// Recordings are made by running the CAD integration tests with CAD_RECORD=1
// against a real CadQuery (see README.md). A request that was never recorded
// fails loudly rather than inventing an answer. Requests are keyed by their
// input names, not contents, so re-record after changing a fixture's bytes.

const here = dirname(fileURLToPath(import.meta.url));
export const RECORDINGS = join(here, 'recorded.json');

// What identifies a request: the mode, the input names, the flags, and for
// an edit the script itself. Input contents are not part of the key: an
// exported STEP file carries a timestamp, so the same part differs byte for
// byte from one export to the next.
export function requestKey(request, script = null) {
  const parts = [
    request.mode,
    (request.inputs ?? []).map((input) => input.name).join(','),
    request.mesh ? 'mesh' : '',
    request.withinFiles ? 'within' : '',
    request.output ? request.output.split('/').pop() : '',
    script == null ? '' : createHash('sha256').update(script).digest('hex').slice(0, 16),
  ];
  return parts.join('|');
}

function readRequest(args) {
  const request = JSON.parse(readFileSync(args.at(-1), 'utf8'));
  const script = request.script ? readFileSync(request.script, 'utf8') : null;
  return { request, script };
}

export function loadRecordings() {
  return existsSync(RECORDINGS) ? JSON.parse(readFileSync(RECORDINGS, 'utf8')) : {};
}

export function recordingSandbox(real, store) {
  return {
    status: real.status,
    async run(options) {
      const { request, script } = readRequest(options.args);
      const result = await real.run(options);
      const files = {};
      const outDir = join(options.cwd, 'out');
      for (const name of ['mesh-0.stl', 'mesh-1.stl', 'mesh-result.stl', request.output ? request.output.split('/').pop() : null].filter(Boolean)) {
        const path = join(outDir, name);
        if (existsSync(path)) files[`out/${name}`] = readFileSync(path).toString('base64');
      }
      // Only the answer line is kept: what the libraries print around it
      // (font and cache warnings) is noise, and may name paths on the
      // recording machine.
      const at = result.output.lastIndexOf('@@SCOPE_CAD@@');
      const output = at === -1 ? result.output.slice(-2000) : `\n${result.output.slice(at).split('\n')[0]}`;
      store[requestKey(request, script)] = { ok: result.ok, exitCode: result.exitCode, output, files };
      return result;
    },
  };
}

export function replaySandbox({ recordings = loadRecordings(), status = { available: true, mechanism: 'replay', reason: null } } = {}) {
  const calls = [];
  return {
    calls,
    async status() {
      return status;
    },
    async run(options) {
      const { request, script } = readRequest(options.args);
      const key = requestKey(request, script);
      calls.push({ key, options });
      const recorded = recordings[key];
      if (!recorded) throw new Error(`no recorded CadQuery answer for ${key}; re-run the CAD integration tests with CAD_RECORD=1 and CadQuery installed (see test/fixtures/cad/README.md)`);
      for (const [name, base64] of Object.entries(recorded.files ?? {})) {
        const path = join(options.cwd, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(base64, 'base64'));
      }
      return { ok: recorded.ok, exitCode: recorded.exitCode, signal: null, timedOut: false, limit: null, output: recorded.output, truncated: false, durationMs: 1, mechanism: 'replay' };
    },
  };
}

export function saveRecordings(store) {
  const sorted = Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(RECORDINGS, `${JSON.stringify(sorted, null, 1)}\n`);
}

// The CadQuery the CAD tests use. With CAD_RECORD=1 (and CADQUERY_PYTHON
// pointing at a Python with CadQuery) it is the real one, recorded, and the
// recordings are added to recorded.json by `save()`, which the test file
// calls when it ends; with CadQuery installed it is the real one; otherwise
// the recordings are played back. `mode` says which, so a test can name what
// it exercised.
export async function cadQueryForTests({ createCadQuery, defaultSandbox }) {
  if (process.env.CAD_RECORD === '1') {
    const store = {};
    return {
      mode: 'recording',
      cadquery: createCadQuery({ sandbox: recordingSandbox(defaultSandbox, store) }),
      save: () => saveRecordings({ ...loadRecordings(), ...store }),
    };
  }
  const real = createCadQuery();
  if ((await real.status()).available) return { mode: 'real', cadquery: real, save: () => {} };
  const sandbox = replaySandbox();
  return { mode: 'replay', cadquery: createCadQuery({ sandbox }), sandbox, save: () => {} };
}
