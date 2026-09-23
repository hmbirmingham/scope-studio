import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// A run is never an arbitrary command. The model may only name a script the
// project itself declares in package.json, and approving one runs
// `npm run <script>` with a fixed argument list — no shell, so there is no
// string for a model to smuggle anything into. The user still approves each
// one, sees the script and the directory, and can decline.

const MAX_RUNS = 100;
const TTL_MS = 2 * 60 * 60 * 1000;
export const RUN_TIMEOUT_MS = 120_000;
// Enough to read a test run; a runaway build does not become a prompt.
export const MAX_OUTPUT = 20_000;

const SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,60}$/;
const RUN_BLOCK = /<run\s*>([\s\S]*?)<\/run>/g;

const runs = new Map();

// `npm test` and friends are the shapes a model reaches for; only the script
// name survives, and it still has to be one the project declares.
function toScriptName(text) {
  const trimmed = text.trim().replace(/^(npm|pnpm|yarn)\s+(run\s+)?/i, '').trim();
  return SCRIPT_NAME.test(trimmed) ? trimmed : null;
}

export function parseRuns(answer) {
  const names = [];
  for (const [, body] of answer.matchAll(RUN_BLOCK)) {
    const name = toScriptName(body);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export async function declaredScripts(cwd) {
  try {
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    return Object.keys(manifest.scripts ?? {});
  } catch {
    return [];
  }
}

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, run] of runs) {
    if (run.createdAt < cutoff) runs.delete(id);
  }
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
}

export function recordRuns({ ownerId, conversationId, project, localPath, scripts, names }) {
  const recorded = names.map((script) => {
    const run = {
      id: randomUUID(),
      ownerId,
      conversationId,
      project: project ?? null,
      cwd: localPath ?? null,
      script,
      command: `npm run ${script}`,
      state: !localPath ? 'unbound' : scripts.includes(script) ? 'proposed' : 'undeclared',
      available: scripts,
      exitCode: null,
      output: null,
      durationMs: null,
      createdAt: Date.now(),
    };
    runs.set(run.id, run);
    return run;
  });
  prune();
  return recorded;
}

export function getRun(ownerId, id) {
  const run = runs.get(id);
  return run && run.ownerId === ownerId ? run : null;
}

export function listRuns(ownerId, { conversationId } = {}) {
  return [...runs.values()].filter(
    (run) => run.ownerId === ownerId && (!conversationId || run.conversationId === conversationId)
  );
}

export function presentRun(run) {
  return {
    id: run.id,
    script: run.script,
    command: run.command,
    project: run.project,
    cwd: run.cwd,
    state: run.state,
    available: run.available,
    exitCode: run.exitCode,
    output: run.output,
    durationMs: run.durationMs,
  };
}

// execFile, not a shell: the script name is an argument, never text to parse.
export function execute(run) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      'npm',
      ['run', '--silent', run.script],
      { cwd: run.cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT * 2, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const combined = `${stdout ?? ''}${stderr ?? ''}`;
        const output = combined.length > MAX_OUTPUT
          ? `${combined.slice(0, MAX_OUTPUT)}\n… output truncated`
          : combined;
        resolve({
          exitCode: err ? (err.code ?? null) : 0,
          durationMs: Date.now() - started,
          output: (output || (err ? `could not run: ${err.message}` : '')).trim(),
          timedOut: Boolean(err?.killed),
        });
      }
    );
  });
}

export function resetRuns() {
  runs.clear();
}
