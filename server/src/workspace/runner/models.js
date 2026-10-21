import { getPool } from '../../db/pool.js';
import { selectAdapter } from '../modelPort.js';
import { decide } from '../permissions.js';
import { recordModelCall } from './ledger.js';

// Every model call a run makes goes through here, in the order the contract
// fixes ("ModelPort" in docs/architecture/agent-workspace.md):
//   1. selectAdapter: what the plan and policy make possible. Local → local.
//   2. Otherwise can(cloud_model): allow → cloud; ask → one approval per run,
//      local until it is approved; deny → local.
//   3. A cloud adapter refusing with platform_unavailable falls back to local
//      for that call, and the fallback is recorded.
// The runner never branches on the adapter otherwise.

const CLOUD_SUMMARY = 'Use the cloud model for this run’s planning and hard steps';

async function findCloudApproval(runId, db) {
  const { rows } = await db.query(
    "SELECT id, status FROM agent_approvals WHERE run_id = $1 AND step_id IS NULL AND capability = 'cloud_model'",
    [runId]
  );
  return rows[0] ?? null;
}

// Opens the run's single cloud request if it has none. The unique index from
// migration 027 settles a race between two calls (or a reclaimed run asking
// again): the loser finds the winner's row.
async function ensureCloudApproval({ run, agent, publish }, db) {
  const existing = await findCloudApproval(run.id, db);
  if (existing) return existing;
  const { rows } = await db.query(
    `INSERT INTO agent_approvals (owner_id, agent_id, run_id, step_id, capability, summary, detail)
     VALUES ($1, $2, $3, NULL, 'cloud_model', $4, $5)
     ON CONFLICT (run_id) WHERE step_id IS NULL AND capability = 'cloud_model' DO NOTHING
     RETURNING id, status`,
    [run.owner_id, agent.id, run.id, CLOUD_SUMMARY, { scope: 'run', permission: 'cloud_model' }]
  );
  if (rows[0]) {
    publish('approval.requested', { approvalId: rows[0].id, capability: 'cloud_model', summary: CLOUD_SUMMARY });
    return rows[0];
  }
  return findCloudApproval(run.id, db);
}

export function createModelRouter({ agent, run, userPlan = 'free', online, adapters, publish, onCall = () => {}, db = getPool() }) {
  if (typeof online !== 'boolean') throw new Error('the model router needs an explicit online flag');
  // The agent may be passed as a getter so a runner that re-reads it between
  // steps decides with the current permissions.
  const current = typeof agent === 'function' ? agent : () => agent;
  const local = adapters.local;
  if (!local) throw new Error('the model router needs a local adapter');

  async function choose({ purpose, hard, privateContext }) {
    if (typeof privateContext !== 'boolean') throw new Error('every model call must say whether its context is private');
    const agent = current();
    const selected = selectAdapter({
      policy: agent.modelPolicy,
      purpose: purpose === 'plan' ? 'plan' : 'step',
      hard: Boolean(hard),
      online,
      plan: userPlan,
      hasOwnKey: Boolean(adapters.own_key),
      privateContext,
    });
    if (selected.adapter === 'local') return { name: 'local', reason: selected.reason };

    // Both flags are passed explicitly: can() fails closed on a missing one.
    const { decision, reason } = decide(agent, 'cloud_model', { project: run.project, online, privateContext });
    if (decision === 'allow') return { name: selected.adapter, reason: selected.reason };
    if (decision === 'deny') return { name: 'local', reason: `cloud_denied:${reason}` };
    const approval = await ensureCloudApproval({ run, agent, publish }, db);
    if (approval?.status === 'approved') return { name: selected.adapter, reason: 'cloud_approved' };
    return { name: 'local', reason: approval?.status === 'rejected' ? 'cloud_rejected' : 'cloud_pending' };
  }

  // Streams one call and records it in the ledger when it completes. The last
  // chunk carries `adapter` and `fallbackFrom` so the step can record them.
  async function* stream({ purpose, hard = false, privateContext, stepId = null, messages, maxTokens, signal, format }) {
    const choice = await choose({ purpose, hard, privateContext });
    let port = choice.name === 'local' ? local : adapters[choice.name];
    let fallbackFrom = null;
    if (!port) {
      port = local;
      fallbackFrom = choice.name;
    }

    const request = { messages, maxTokens, signal, purpose: purpose === 'plan' ? 'plan' : 'step', format };
    let finished = null;
    let produced = false;
    const relay = async function* (from) {
      for await (const chunk of from.stream(request)) {
        if (chunk.done) finished = chunk;
        else if (chunk.text) {
          produced = true;
          yield chunk;
        }
      }
    };
    try {
      yield* relay(port);
    } catch (err) {
      // The one place the runner looks at an adapter's outcome: a cloud
      // adapter that cannot serve (signed out, offline, allowance used up)
      // before producing anything hands the call to the local model.
      if (err?.code !== 'platform_unavailable' || port === local || produced) throw err;
      fallbackFrom = port.name;
      port = local;
      finished = null;
      yield* relay(port);
    }

    const usage = finished?.usage ?? null;
    const usd = port === local ? 0 : Number(finished?.costUsd ?? 0) || 0;
    const recorded = await recordModelCall(
      {
        ownerId: run.owner_id,
        runId: run.id,
        stepId,
        purpose,
        adapter: port.name,
        fallbackFrom,
        model: finished?.model ?? null,
        usage,
        usd,
      },
      db
    );
    publish('cost', { tokens: recorded.tokens, usd: recorded.usd, adapter: port.name });
    onCall({ stepId, adapter: port.name, fallbackFrom, reason: choice.reason });
    yield { done: true, usage, costUsd: usd, model: finished?.model ?? null, adapter: port.name, fallbackFrom, reason: choice.reason };
  }

  async function complete(options) {
    let text = '';
    let done = null;
    for await (const chunk of stream(options)) {
      if (chunk.done) done = chunk;
      else text += chunk.text;
    }
    return { text, ...done };
  }

  // The ModelPort a capability receives in ctx.model: same interface as an
  // adapter, but every call goes through the order above and the ledger.
  function portFor({ hard = false, privateContext, stepId }) {
    return {
      name: 'run',
      offline: !online,
      stream: ({ messages, maxTokens, signal, format }) =>
        stream({ purpose: 'capability', hard, privateContext, stepId, messages, maxTokens, signal, format }),
    };
  }

  return { choose, stream, complete, portFor };
}
