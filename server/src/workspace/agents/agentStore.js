import { getPool } from '../../db/pool.js';
import { workspaceEvents } from '../events.js';
import { AGENT_COLORS, isUuid } from './validation.js';

// Agents and their kill switch. Every query is scoped to owner_id, and every
// state change is a conditional UPDATE inside a transaction (see "Run
// lifecycle across paths"), so two requests can never both win a transition.
// Events are published after the commit, never before: a subscriber must not
// hear about a change that then rolls back.

export async function listAgents(ownerId) {
  const { rows } = await getPool().query('SELECT * FROM agents WHERE owner_id = $1 ORDER BY created_at, id', [ownerId]);
  return rows;
}

export async function getAgent(ownerId, id) {
  if (!isUuid(id)) return null;
  const { rows } = await getPool().query('SELECT * FROM agents WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rows[0] ?? null;
}

export async function createAgent(ownerId, agent) {
  const pool = getPool();
  let color = agent.color;
  if (!color) {
    // Chosen by how many agents the user already has, so colours cycle in a
    // fixed order and the same history always yields the same colour.
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM agents WHERE owner_id = $1', [ownerId]);
    color = AGENT_COLORS[rows[0].count % AGENT_COLORS.length];
  }
  const { rows } = await pool.query(
    `INSERT INTO agents (owner_id, name, role, level, overrides, scopes, model_policy, budget, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [ownerId, agent.name, agent.role, agent.level, agent.overrides, agent.scopes, agent.modelPolicy, agent.budget, color]
  );
  return rows[0];
}

// `next` holds the complete, already validated agent fields.
export async function updateAgent(ownerId, id, next) {
  if (!isUuid(id)) return null;
  const { rows } = await getPool().query(
    `UPDATE agents SET name = $3, role = $4, level = $5, overrides = $6, scopes = $7,
       model_policy = $8, budget = $9, color = $10, updated_at = now()
     WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [id, ownerId, next.name, next.role, next.level, next.overrides, next.scopes, next.modelPolicy, next.budget, next.color]
  );
  return rows[0] ?? null;
}

export async function deleteAgent(ownerId, id) {
  if (!isUuid(id)) return false;
  const { rowCount } = await getPool().query('DELETE FROM agents WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rowCount > 0;
}

const LIVE_RUN_STATUSES = ['queued', 'running', 'waiting_approval'];
const NON_TERMINAL_RUN_STATUSES = [...LIVE_RUN_STATUSES, 'paused'];

// Runs the transition's SQL in one transaction. `fromStates` is what the agent
// must be in; if it is not, the answer is 404 (not this owner's) or 409 (wrong
// state). `apply` receives the client and the updated agent and returns the
// events to publish once committed.
async function transition(ownerId, id, { fromStates, toState }, apply) {
  if (!isUuid(id)) return { status: 404 };
  const client = await getPool().connect();
  let events = [];
  let agent;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE agents SET state = $3, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND state = ANY($4::text[]) RETURNING *`,
      [id, ownerId, toState, fromStates]
    );
    if (!rows[0]) {
      const { rows: existing } = await client.query('SELECT state FROM agents WHERE id = $1 AND owner_id = $2', [id, ownerId]);
      await client.query('ROLLBACK');
      return existing[0] ? { status: 409, state: existing[0].state } : { status: 404 };
    }
    agent = rows[0];
    events = await apply(client, agent);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const event of events) workspaceEvents.publish(event);
  return { status: 200, agent };
}

const runEvent = (ownerId, agentId, runId, type, data = {}) => ({ ownerId, agentId, runId, type, data });

export function pauseAgent(ownerId, id) {
  return transition(ownerId, id, { fromStates: ['active'], toState: 'paused' }, async (client, agent) => {
    const { rows } = await client.query(
      `UPDATE agent_runs SET status = 'paused'
       WHERE agent_id = $1 AND owner_id = $2 AND status = ANY($3::text[]) RETURNING id`,
      [agent.id, ownerId, LIVE_RUN_STATUSES]
    );
    return rows.map((run) => runEvent(ownerId, agent.id, run.id, 'run.paused'));
  });
}

export function resumeAgent(ownerId, id) {
  return transition(ownerId, id, { fromStates: ['paused'], toState: 'active' }, async (client, agent) => {
    const { rows } = await client.query(
      `UPDATE agent_runs SET status = 'queued'
       WHERE agent_id = $1 AND owner_id = $2 AND status = 'paused' RETURNING id`,
      [agent.id, ownerId]
    );
    return rows.map((run) => runEvent(ownerId, agent.id, run.id, 'run.queued'));
  });
}

export function killAgent(ownerId, id) {
  return transition(ownerId, id, { fromStates: ['active', 'paused'], toState: 'killed' }, async (client, agent) => {
    const { rows: runs } = await client.query(
      `UPDATE agent_runs SET status = 'killed', finished_at = now(), lease_owner = NULL, lease_until = NULL
       WHERE agent_id = $1 AND owner_id = $2 AND status = ANY($3::text[]) RETURNING id`,
      [agent.id, ownerId, NON_TERMINAL_RUN_STATUSES]
    );
    const killed = runs.map((run) => run.id);
    const { rows: approvals } = killed.length
      ? await client.query(
          `UPDATE agent_approvals SET status = 'expired', resolved_at = now()
           WHERE owner_id = $1 AND run_id = ANY($2::uuid[]) AND status = 'pending' RETURNING id, run_id`,
          [ownerId, killed]
        )
      : { rows: [] };
    return [
      ...approvals.map((a) => runEvent(ownerId, agent.id, a.run_id, 'approval.resolved', { approvalId: a.id, status: 'expired' })),
      ...killed.map((runId) => runEvent(ownerId, agent.id, runId, 'run.finished', { status: 'killed' })),
    ];
  });
}

// Killed runs stay killed: re-activating the agent only lets new work start.
export function reactivateAgent(ownerId, id) {
  return transition(ownerId, id, { fromStates: ['killed'], toState: 'active' }, async () => []);
}
