import { getPool } from '../../db/pool.js';
import { nextRunAt } from '../cron.js';
import { isUuid } from './validation.js';

// Tasks are scoped to owner_id; the composite foreign key to agents (see
// migration 021) additionally makes it impossible to point one at another
// user's agent even if a caller forgot to check.

// Only a scheduled, enabled task has a next run; everything else is null.
export function computeNextRun({ schedule, enabled }, now = new Date()) {
  return schedule && enabled ? nextRunAt(schedule, now) : null;
}

export async function listTasks(ownerId, { agentId } = {}) {
  const { rows } = await getPool().query(
    `SELECT * FROM tasks WHERE owner_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) ORDER BY created_at, id`,
    [ownerId, agentId ?? null]
  );
  return rows;
}

export async function getTask(ownerId, id) {
  if (!isUuid(id)) return null;
  const { rows } = await getPool().query('SELECT * FROM tasks WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rows[0] ?? null;
}

export async function createTask(ownerId, task) {
  const { rows } = await getPool().query(
    `INSERT INTO tasks (owner_id, agent_id, title, instructions, project, schedule, next_run_at, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [ownerId, task.agentId, task.title, task.instructions, task.project, task.schedule, computeNextRun(task), task.enabled]
  );
  return rows[0];
}

// `next` holds the complete merged task; next_run_at is always recomputed.
export async function updateTask(ownerId, id, next) {
  if (!isUuid(id)) return null;
  const { rows } = await getPool().query(
    `UPDATE tasks SET agent_id = $3, title = $4, instructions = $5, project = $6, schedule = $7,
       next_run_at = $8, enabled = $9, updated_at = now()
     WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [id, ownerId, next.agentId, next.title, next.instructions, next.project, next.schedule, computeNextRun(next), next.enabled]
  );
  return rows[0] ?? null;
}

export async function deleteTask(ownerId, id) {
  if (!isUuid(id)) return false;
  const { rowCount } = await getPool().query('DELETE FROM tasks WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rowCount > 0;
}
