import { getPool } from '../../db/pool.js';

// Database access for the runner. Every status change here is conditional on
// the status (and, for a worker, the lease) it expects, as "Run lifecycle
// across paths" in docs/architecture/agent-workspace.md requires: another
// module's pause or kill is never overwritten by a worker that had not seen it.

export const TERMINAL_STATUSES = ['succeeded', 'failed', 'killed', 'budget_exceeded'];
export const ACTIVE_STATUSES = ['queued', 'running', 'paused', 'waiting_approval'];

// A run claimed this many times without making progress is failed rather
// than reclaimed forever.
export const MAX_ATTEMPTS = 3;

const RUN_COLUMNS =
  'id, owner_id, agent_id, task_id, scheduled_for, instructions, project, status, plan_node_id, step_index, ' +
  'checkpoint, budget, tokens_used, cost_usd, wall_ms, lease_owner, lease_until, attempts, error, queued_at, ' +
  'started_at, finished_at';

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

export function presentRun(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    taskId: row.task_id,
    instructions: row.instructions,
    project: row.project,
    status: row.status,
    stepIndex: row.step_index,
    tokensUsed: row.tokens_used,
    costUsd: Number(row.cost_usd),
    wallMs: Number(row.wall_ms),
    budget: row.budget ?? {},
    error: row.error,
    queuedAt: iso(row.queued_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    planNodeId: row.plan_node_id,
  };
}

export function presentStep(row) {
  return {
    id: row.id,
    index: row.index,
    kind: row.kind,
    capability: row.capability,
    status: row.status,
    input: row.input,
    output: row.output,
    verification: row.verification,
    adapter: row.adapter,
    tokens: row.tokens,
    costUsd: Number(row.cost_usd),
    nodeIds: row.node_ids,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

export function presentAgent(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    role: row.role ?? {},
    level: row.level,
    overrides: row.overrides ?? {},
    scopes: row.scopes ?? {},
    modelPolicy: row.model_policy,
    budget: row.budget ?? {},
    state: row.state,
    color: row.color,
  };
}

export async function loadAgent(ownerId, agentId, db = getPool()) {
  const { rows } = await db.query('SELECT * FROM agents WHERE id = $1 AND owner_id = $2', [agentId, ownerId]);
  return rows[0] ? presentAgent(rows[0]) : null;
}

export async function loadRun(runId, db = getPool()) {
  const { rows } = await db.query(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = $1`, [runId]);
  return rows[0] ?? null;
}

export async function insertRun({ ownerId, agentId, taskId = null, instructions, project = null, budget = {}, scheduledFor = null }, db = getPool()) {
  const { rows } = await db.query(
    `INSERT INTO agent_runs (owner_id, agent_id, task_id, instructions, project, budget, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (task_id, scheduled_for) DO NOTHING
     RETURNING ${RUN_COLUMNS}`,
    [ownerId, agentId, taskId, instructions, project, budget, scheduledFor]
  );
  return rows[0] ?? null;
}

// Claims the oldest queued run, or a running run whose lease expired (its
// worker died), in one statement so two workers can never take the same run.
// `was_started` tells the caller whether this is a fresh start or a resume.
export async function claimRun({ workerId, leaseMs }, db = getPool()) {
  const { rows } = await db.query(
    `WITH next AS (
       SELECT id, started_at IS NOT NULL AS was_started
       FROM agent_runs
       WHERE status = 'queued' OR (status = 'running' AND lease_until < now())
       ORDER BY queued_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE agent_runs r
     SET status = 'running',
         lease_owner = $1,
         lease_until = now() + make_interval(secs => $2::float8 / 1000),
         attempts = r.attempts + 1,
         started_at = COALESCE(r.started_at, now())
     FROM next
     WHERE r.id = next.id
     RETURNING ${RUN_COLUMNS.split(', ').map((column) => `r.${column}`).join(', ')}, next.was_started`,
    [workerId, leaseMs]
  );
  return rows[0] ?? null;
}

// Extends the lease, and reports whether this worker still holds a running
// run: false means it was paused, killed or reclaimed, and the worker stops.
export async function renewLease(runId, { workerId, leaseMs }, db = getPool()) {
  const { rowCount } = await db.query(
    `UPDATE agent_runs SET lease_until = now() + make_interval(secs => $3::float8 / 1000)
     WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
    [runId, workerId, leaseMs]
  );
  return rowCount === 1;
}

// A terminal (or paused) transition made by the worker that holds the run.
// Returns the updated row, or null when someone else changed the run first.
export async function transitionHeld(runId, workerId, { status, error = null, wallMs = null }, db = getPool()) {
  const terminal = TERMINAL_STATUSES.includes(status);
  const { rows } = await db.query(
    `UPDATE agent_runs
     SET status = $3,
         error = COALESCE($4, error),
         wall_ms = COALESCE($5, wall_ms),
         finished_at = CASE WHEN $6 THEN now() ELSE finished_at END,
         lease_owner = NULL,
         lease_until = NULL,
         attempts = CASE WHEN $3 = 'queued' THEN 0 ELSE attempts END
     WHERE id = $1 AND status = 'running' AND lease_owner = $2
     RETURNING ${RUN_COLUMNS}`,
    [runId, workerId, status, error, wallMs, terminal]
  );
  return rows[0] ?? null;
}

// The kill switch from a route: any non-terminal run becomes killed, and its
// pending approvals expire so the inbox does not offer to approve dead work.
export async function killRun(ownerId, runId, db = getPool()) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE agent_runs
       SET status = 'killed', finished_at = now(), lease_owner = NULL, lease_until = NULL
       WHERE id = $1 AND owner_id = $2 AND status = ANY($3)
       RETURNING ${RUN_COLUMNS}`,
      [runId, ownerId, ACTIVE_STATUSES]
    );
    let expired = [];
    if (rows[0]) {
      ({ rows: expired } = await client.query(
        "UPDATE agent_approvals SET status = 'expired', resolved_at = now() WHERE run_id = $1 AND status = 'pending' RETURNING id",
        [runId]
      ));
    }
    await client.query('COMMIT');
    return rows[0] ? { run: rows[0], expiredApprovalIds: expired.map((row) => row.id) } : null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listRuns(ownerId, { agentId, status } = {}, db = getPool()) {
  const conditions = ['owner_id = $1'];
  const values = [ownerId];
  if (agentId) {
    values.push(agentId);
    conditions.push(`agent_id = $${values.length}`);
  }
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE ${conditions.join(' AND ')} ORDER BY queued_at DESC LIMIT 200`,
    values
  );
  return rows;
}

export async function getOwnedRun(ownerId, runId, db = getPool()) {
  const { rows } = await db.query(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = $1 AND owner_id = $2`, [runId, ownerId]);
  return rows[0] ?? null;
}

export async function listSteps(runId, db = getPool()) {
  const { rows } = await db.query('SELECT * FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [runId]);
  return rows;
}

export async function getStepAt(runId, index, db = getPool()) {
  const { rows } = await db.query('SELECT * FROM agent_run_steps WHERE run_id = $1 AND index = $2', [runId, index]);
  return rows[0] ?? null;
}

// Starts (or restarts, after a crash) the step at `index`. A step that was
// running when its worker died had not checkpointed, so it is redone; its row
// is reused so the ledger rows it already earned stay attached to it.
export async function startStep(runId, { index, kind }, db = getPool()) {
  const { rows } = await db.query(
    `INSERT INTO agent_run_steps (run_id, index, kind, status, started_at)
     VALUES ($1, $2, $3, 'running', now())
     ON CONFLICT (run_id, index) DO UPDATE
       SET kind = EXCLUDED.kind, status = 'running', capability = NULL, input = '{}', output = NULL,
           verification = NULL, adapter = NULL, detail = '{}', error = NULL, node_ids = '{}',
           started_at = now(), finished_at = NULL
     RETURNING *`,
    [runId, index, kind]
  );
  return rows[0];
}

export async function updateStep(stepId, fields, db = getPool()) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return;
  const sets = columns.map((column, i) => `${column} = $${i + 2}`);
  await db.query(`UPDATE agent_run_steps SET ${sets.join(', ')} WHERE id = $1`, [stepId, ...columns.map((column) => fields[column])]);
}

// The status the kill switch and pause read before each stage.
export async function readControl(runId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT r.status, r.lease_owner, r.tokens_used, r.cost_usd, a.state AS agent_state
     FROM agent_runs r JOIN agents a ON a.id = r.agent_id AND a.owner_id = r.owner_id
     WHERE r.id = $1`,
    [runId]
  );
  return rows[0] ?? null;
}
