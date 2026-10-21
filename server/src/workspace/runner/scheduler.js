import { getPool } from '../../db/pool.js';
import { nextRunAt } from '../cron.js';
import { workspaceEvents } from '../events.js';

// The scheduler: enqueues recurring tasks when they fall due. Each due task is
// locked with FOR UPDATE SKIP LOCKED, its run is inserted for the exact slot
// (`scheduled_for`, unique per task) and `next_run_at` is advanced in the same
// transaction, so two schedulers (two engine processes, or a restart racing
// the old one) can never enqueue the same slot twice.

export const DEFAULT_SCHEDULER_MS = 30_000;
const BATCH = 50;

// Missed slots are not replayed: after downtime a task runs once, for the
// slot that was due, and the next slot is the first one after now. A machine
// that slept through a night of hourly runs should not wake to eight of them.
export function advance(schedule, slot, now) {
  try {
    return nextRunAt(schedule, new Date(Math.max(new Date(slot).getTime(), now.getTime())));
  } catch {
    return null;
  }
}

export async function enqueueDueTasks({ now = () => new Date(), events = workspaceEvents, db = getPool() } = {}) {
  const client = await db.connect();
  const queued = [];
  try {
    await client.query('BEGIN');
    const { rows: tasks } = await client.query(
      `SELECT t.id, t.owner_id, t.agent_id, t.instructions, t.project, t.schedule, t.next_run_at, a.state AS agent_state
       FROM tasks t JOIN agents a ON a.id = t.agent_id AND a.owner_id = t.owner_id
       WHERE t.enabled AND t.schedule IS NOT NULL AND t.next_run_at IS NOT NULL AND t.next_run_at <= $1
       ORDER BY t.next_run_at
       LIMIT ${BATCH}
       FOR UPDATE OF t SKIP LOCKED`,
      [now()]
    );
    for (const task of tasks) {
      // A paused or killed agent starts nothing new; its slot passes unrun,
      // and the schedule carries on from the next one.
      if (task.agent_state === 'active') {
        const { rows } = await client.query(
          `INSERT INTO agent_runs (owner_id, agent_id, task_id, scheduled_for, instructions, project)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (task_id, scheduled_for) DO NOTHING
           RETURNING id, owner_id, agent_id, scheduled_for`,
          [task.owner_id, task.agent_id, task.id, task.next_run_at, task.instructions, task.project]
        );
        if (rows[0]) queued.push(rows[0]);
      }
      // An unparseable schedule (written before validation, or by hand) stops
      // the task rather than failing every tick.
      await client.query('UPDATE tasks SET next_run_at = $2, updated_at = now() WHERE id = $1', [
        task.id,
        advance(task.schedule, task.next_run_at, now()),
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  for (const run of queued) {
    events.publish({ runId: run.id, agentId: run.agent_id, ownerId: run.owner_id, type: 'run.queued', data: { scheduledFor: new Date(run.scheduled_for).toISOString() } });
  }
  return queued.map((run) => run.id);
}

export function createScheduler({ intervalMs = DEFAULT_SCHEDULER_MS, onQueued = () => {}, onError = (err) => console.error(`agent scheduler: ${err.message}`), ...options } = {}) {
  let timer = null;
  let ticking = null;
  async function tick() {
    try {
      const ids = await enqueueDueTasks(options);
      if (ids.length > 0) onQueued(ids);
      return ids;
    } catch (err) {
      onError(err);
      return [];
    }
  }
  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (!ticking) ticking = tick().finally(() => (ticking = null));
      }, intervalMs);
      timer.unref?.();
      ticking = tick().finally(() => (ticking = null));
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      await ticking;
    },
  };
}
