import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ingestProblems } from '../../plugins/physics/ingest.js';
import { registerBuiltInPlugins } from '../../plugins/registry.js';
import { createEventBus } from '../../workspace/events.js';
import { roleTemplate } from '../../workspace/roles.js';
import { executeRun } from '../../workspace/runner/execute.js';
import { runCosts } from '../../workspace/runner/ledger.js';
import { sandboxRoot } from '../../workspace/runner/sandbox.js';
import { insertRun, loadRun } from '../../workspace/runner/store.js';
import { problemOf } from './catalog.js';
import { createCallLog, createScript, livePlatformPort, recordedLocalPort, scriptedPort } from './models.js';
import { prepareLibrary } from './research.js';
import { prepareProject, snapshotTree } from './workspace.js';

// The Scope arm: the real runner (executeRun, the same function the worker
// calls) with the real code plug-in, the run's sandbox and the OS sandbox,
// an agent at the sandboxed autonomous level, and the knowledge graph as the
// run's only memory. Each step reads a fixed-size slice of the graph, never
// a transcript, which is the property the benchmark measures.

// The built-in role for the kind of task: Debugger, whose tags cover
// reading, editing, the project's scripts and generated code; Researcher,
// whose tags cover the research plug-in; Physicist, whose tags cover the
// physics plug-in. A task may still name a role of its own (`task.role`).
export const ROLE_FOR_KIND = Object.freeze({ code: 'debugger', research: 'researcher', physics: 'physicist' });

export function roleFor(task) {
  return task?.role ?? ROLE_FOR_KIND[task?.kind] ?? ROLE_FOR_KIND.code;
}
const LEASE_MS = 60_000;
// Generous limits: a dry run ends well inside them, and a live run should
// stop on the task, not on a budget the benchmark set.
export const SCOPE_BUDGET = Object.freeze({ maxTokens: 2_000_000, maxUsd: 1, maxWallMs: 15 * 60_000, maxSteps: 40 });

// Claims this run, and only this run, the way claimRun claims the oldest one.
// The harness never takes a run it did not create, so it is safe to point it
// at a database where other people's runs are queued.
async function claimOwn(runId, workerId, db) {
  const { rowCount } = await db.query(
    `UPDATE agent_runs
     SET status = 'running', lease_owner = $2, lease_until = now() + make_interval(secs => $3::float8 / 1000),
         attempts = attempts + 1, started_at = COALESCE(started_at, now())
     WHERE id = $1 AND status = 'queued'`,
    [runId, workerId, LEASE_MS]
  );
  if (rowCount !== 1) return null;
  const run = await loadRun(runId, db);
  return { ...run, was_started: false };
}

async function createBenchAgent({ db, ownerId, project, arm, task }) {
  const role = roleTemplate(roleFor(task));
  // Local+cloud: the user has said yes to the cloud for this agent, so the
  // plan's cloud calls are allowed without a per-run approval.
  const overrides = arm.policy === 'local_cloud' ? { cloud_model: 'allow' } : {};
  const { rows } = await db.query(
    `INSERT INTO agents (owner_id, name, role, level, overrides, scopes, model_policy, budget)
     VALUES ($1, $2, $3, 'sandboxed', $4, $5, $6, $7) RETURNING id`,
    [
      ownerId,
      `Benchmark ${arm.name}`,
      role,
      overrides,
      { read: { projects: [project], sources: ['*'] }, write: { projects: [project] } },
      arm.policy,
      SCOPE_BUDGET,
    ]
  );
  return rows[0].id;
}

function adaptersFor({ arm, mode, task, log, cap, apiKey }) {
  if (mode === 'dry') {
    const script = createScript(task);
    return { local: scriptedPort({ name: 'local', script, log }), platform: scriptedPort({ name: 'platform', script, log }) };
  }
  const local = recordedLocalPort({ log });
  if (arm.policy !== 'local_cloud') return { local };
  return { local, platform: livePlatformPort({ apiKey, cap, log }) };
}

export async function runScopeTask({ task, arm, workspace, ownerId, db, mode = 'dry', cap, apiKey }) {
  registerBuiltInPlugins();
  const project = `bench-${task.id}-${arm.name}`;
  // A code task works on a checkout of its fixture; a research task on its
  // paper set, ingested into the graph under the arm's project.
  if (task.kind === 'research') {
    await prepareLibrary(task, { ownerId, project, db, embed: mode !== 'dry' });
  } else {
    const repo = await prepareProject(task, workspace, arm.name);
    await db.query('INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, $2, $3)', [ownerId, project, repo]);
    // A physics task's problem is a node in the project's graph, which is
    // where the agent reads it from.
    if (task.kind === 'physics') {
      await ingestProblems(ownerId, { project, privacy: 'cloud', problems: [problemOf(task)] }, { embed: mode === 'dry' ? null : undefined });
    }
  }
  const agentId = await createBenchAgent({ db, ownerId, project, arm, task });
  const run = await insertRun({ ownerId, agentId, instructions: task.instructions, project }, db);

  // The worker removes the run's sandbox as soon as the run ends, right after
  // it publishes run.finished; the result is copied out on that event.
  const resultDir = join(workspace.dir('results', task.id), arm.name);
  let snapshot = null;
  const bus = createEventBus();
  bus.subscribe({ ownerId, runId: run.id }, (event) => {
    if (event.type !== 'run.finished') return;
    const worktree = join(sandboxRoot(run.id, { env: workspace.sandboxEnv }), 'worktree');
    if (existsSync(worktree)) snapshot = snapshotTree(worktree, resultDir);
  });

  const log = createCallLog();
  const adapters = adaptersFor({ arm, mode, task, log, cap, apiKey });
  const workerId = `task-benchmark-${randomUUID().slice(0, 8)}`;
  const errors = [];
  const started = performance.now();
  // A run hands itself back (queued) only when its worker stops; anything
  // else ends this loop: finished, parked for an approval, or stopped.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claimed = await claimOwn(run.id, workerId, db);
    if (!claimed) break;
    await executeRun(claimed, {
      workerId,
      leaseMs: LEASE_MS,
      heartbeatMs: 1_000,
      adapters,
      online: true,
      embed: mode !== 'dry',
      events: bus,
      db,
      sandboxEnv: workspace.sandboxEnv,
      planOf: async () => (arm.policy === 'local_cloud' ? 'engineer' : 'free'),
      onSandboxError: (err) => errors.push(err.message),
    });
  }
  const wallMs = Math.round(performance.now() - started);

  const final = await loadRun(run.id, db);
  const { rows: steps } = await db.query('SELECT index, kind, capability, status, error FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [run.id]);
  const ledger = await runCosts(run.id, db);
  // What the verified steps produced, for a check that reads a result rather
  // than a working tree.
  const { rows: answers } = await db.query(
    "SELECT capability, output FROM agent_run_steps WHERE run_id = $1 AND status = 'done' AND capability IS NOT NULL ORDER BY index",
    [run.id]
  );
  const claimedDone = final.status === 'succeeded';
  // The run's conclusion, which a research task's check reads: the summary
  // the final step gave when it declared the goal met.
  const { rows: [last] } = await db.query(
    "SELECT output->>'summary' AS summary FROM agent_run_steps WHERE run_id = $1 AND output->>'done' = 'true' ORDER BY index DESC LIMIT 1",
    [run.id]
  );

  return {
    runId: run.id,
    runStatus: final.status,
    runError: final.error,
    claimedDone,
    // The objective check runs on this afterwards (run.js), outside the timing.
    resultDir: snapshot,
    // What a check reads besides the working tree: the verified steps'
    // outputs (physics) and the final answer in the arm's project (research).
    answers,
    project,
    answer: last?.summary ?? null,
    wallMs,
    // Every step the runner executed, the plan included.
    steps: steps.length,
    stepRecord: steps.map((step) => ({ index: step.index, kind: step.kind, capability: step.capability, status: step.status, error: step.error })),
    calls: log.calls,
    ledger: {
      costUsd: ledger.reduce((sum, row) => sum + row.usd, 0),
      tokens: ledger.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0),
      calls: ledger.length,
    },
    errors,
  };
}
