import { getPool } from '../../db/pool.js';
import { workspaceEvents } from '../events.js';
import { isUuid } from './validation.js';

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'];

export async function listApprovals(ownerId, { status } = {}) {
  const { rows } = await getPool().query(
    `SELECT * FROM agent_approvals WHERE owner_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC, id`,
    [ownerId, status ?? null]
  );
  return rows;
}

export async function getApproval(ownerId, id) {
  if (!isUuid(id)) return null;
  const { rows } = await getPool().query('SELECT * FROM agent_approvals WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rows[0] ?? null;
}

// Resolves one approval in a single transaction. If it was the last pending
// approval of a run that is waiting on approvals, the run goes back to
// `queued` so a worker picks it up. The run row is locked first: two
// approvals of one run resolved at the same moment would otherwise each see
// the other as still pending and neither would re-queue the run.
export async function resolveApproval(ownerId, id, decision) {
  if (!isUuid(id)) return { status: 404 };
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const client = await getPool().connect();
  let approval;
  let requeued = false;
  try {
    await client.query('BEGIN');
    const { rows: found } = await client.query('SELECT run_id FROM agent_approvals WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (!found[0]) {
      await client.query('ROLLBACK');
      return { status: 404 };
    }
    if (found[0].run_id) await client.query('SELECT 1 FROM agent_runs WHERE id = $1 AND owner_id = $2 FOR UPDATE', [found[0].run_id, ownerId]);
    const { rows } = await client.query(
      `UPDATE agent_approvals SET status = $3, resolved_at = now()
       WHERE id = $1 AND owner_id = $2 AND status = 'pending' RETURNING *`,
      [id, ownerId, status]
    );
    if (!rows[0]) {
      const { rows: current } = await client.query('SELECT * FROM agent_approvals WHERE id = $1 AND owner_id = $2', [id, ownerId]);
      await client.query('ROLLBACK');
      return { status: 409, approval: current[0] };
    }
    approval = rows[0];
    if (approval.run_id) {
      const { rowCount } = await client.query(
        `UPDATE agent_runs SET status = 'queued'
         WHERE id = $1 AND owner_id = $2 AND status = 'waiting_approval'
           AND NOT EXISTS (SELECT 1 FROM agent_approvals WHERE run_id = $1 AND status = 'pending')`,
        [approval.run_id, ownerId]
      );
      requeued = rowCount > 0;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const base = { ownerId, agentId: approval.agent_id, runId: approval.run_id };
  workspaceEvents.publish({ ...base, type: 'approval.resolved', data: { approvalId: approval.id, status } });
  if (requeued) workspaceEvents.publish({ ...base, type: 'run.queued', data: {} });
  return { status: 200, approval };
}
