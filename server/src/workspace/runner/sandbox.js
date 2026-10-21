import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { getPool } from '../../db/pool.js';
import { createSandbox, createScratchSandbox, realpathLoose, removeSandbox, sandboxesDir } from '../sandbox/index.js';
import { TERMINAL_STATUSES } from './store.js';

// A run's sandbox (docs/architecture/agent-workspace.md, "Sandboxes"): the
// private copy of the project that capabilities which change or run
// something work in. The runner makes it the first time a step needs it,
// keeps it for the rest of the run so every later step (reads included) sees
// the run's own edits, records where it lives in the run's checkpoint so a
// resumed run finds it again, and removes it when the run reaches a terminal
// state.

// The permissions whose capabilities run in the sandbox. Verifiers attached
// to one of them run under the same decision, in the same sandbox.
export const SANDBOX_PERMISSIONS = new Set(['edit_files', 'run_scripts', 'run_generated_code']);

export function sandboxRoot(runId, { env } = {}) {
  return join(sandboxesDir({ env }), runId);
}

function isGitCheckout(path) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', path, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      { timeout: 30_000, killSignal: 'SIGKILL', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } },
      (err) => resolve(!err)
    );
  });
}

async function exists(path) {
  return Boolean(await lstat(path).catch(() => null));
}

// The record the checkpoint keeps. The paths are always derived from the
// run id rather than trusted from the row, so a corrupted checkpoint can
// never point the runner at another directory.
function recordOf(sandbox) {
  return { root: sandbox.root, kind: sandbox.worktree ? 'project' : 'scratch', head: sandbox.head ?? null };
}

function fromRecord(runId, record, { env } = {}) {
  const root = realpathLoose(sandboxRoot(runId, { env }));
  if (!record || realpathLoose(record.root ?? '') !== root) return null;
  const project = record.kind === 'project';
  return {
    id: runId,
    root,
    gitDir: project ? join(root, 'git') : null,
    worktree: project ? join(root, 'worktree') : null,
    scratch: join(root, 'scratch'),
    head: record.head ?? null,
    carried: null,
  };
}

// One run's sandbox. `persist(record)` stores the record in the run's
// checkpoint (conditional on the worker still holding the run) and throws if
// it no longer does.
export function createRunSandbox({ runId, localPath, record = null, persist, env }) {
  let sandbox = null;
  let kind;

  // 'project' when the project has a git checkout to copy, otherwise
  // 'scratch' (an empty directory generated code can run in). Settled once
  // per run: a run's checkout does not change under it.
  async function kindOf() {
    if (kind === undefined) kind = localPath && (await isGitCheckout(localPath)) ? 'project' : 'scratch';
    return kind;
  }

  return {
    // Whether a capability would run inside the sandbox, which is what can()
    // is told as `inSandbox`. Editing files or running the project's scripts
    // is sandboxed only when there is a project copy to do it in; generated
    // code always runs in one (a scratch directory at least).
    async applies(capability) {
      if (!SANDBOX_PERMISSIONS.has(capability?.permission)) return false;
      if (capability.permission === 'run_generated_code') return true;
      return (await kindOf()) === 'project';
    },

    // The sandbox if the run already has one on disk, without making one:
    // what read-only steps see, so they read the run's own edits.
    async current() {
      if (sandbox) return sandbox;
      const found = fromRecord(runId, record, { env });
      if (found && (await exists(found.worktree ?? found.scratch))) sandbox = found;
      return sandbox;
    },

    // The run's sandbox, made (or remade, if the recorded one is gone) when
    // a step first needs it.
    async ensure() {
      if (await this.current()) return sandbox;
      const root = sandboxRoot(runId, { env });
      // A sandbox left half made (a crash before it was recorded, or one
      // whose worktree was deleted) is removed and made again.
      if (await exists(root)) await removeSandbox(root, { env });
      const made = (await kindOf()) === 'project'
        ? await createSandbox({ runId, repoPath: localPath, env })
        : await createScratchSandbox({ runId, env });
      try {
        record = recordOf(made);
        await persist(record);
      } catch (err) {
        await removeSandbox(made, { env }).catch(() => {});
        record = null;
        throw err;
      }
      sandbox = made;
      return sandbox;
    },
  };
}

// Removes a run's sandbox and forgets it, once the run is terminal. The
// directory is found from the run id; the record only says there is one.
export async function removeRunSandbox(runId, { db = getPool(), env } = {}) {
  await removeSandbox(sandboxRoot(runId, { env }), { env });
  await db.query(
    "UPDATE agent_runs SET checkpoint = checkpoint - 'sandbox' WHERE id = $1 AND status = ANY($2)",
    [runId, TERMINAL_STATUSES]
  );
}

// Removes the sandboxes of runs that ended while no worker held them: a run
// killed while it waited for approval or was paused, for example. Workers
// call it when idle; it is safe to run from several at once.
export async function sweepSandboxes({ db = getPool(), env, limit = 20, onError = () => {} } = {}) {
  const { rows } = await db.query(
    "SELECT id FROM agent_runs WHERE status = ANY($1) AND checkpoint ? 'sandbox' ORDER BY finished_at NULLS FIRST LIMIT $2",
    [TERMINAL_STATUSES, limit]
  );
  const removed = [];
  for (const { id } of rows) {
    try {
      await removeRunSandbox(id, { db, env });
      removed.push(id);
    } catch (err) {
      onError(err);
    }
  }
  return removed;
}
