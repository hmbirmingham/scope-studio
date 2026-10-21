import { getPool } from '../../db/pool.js';

// The per-run cost ledger (migration 025): one row per model call, counts and
// money only. The run's totals are recomputed from it after every call, so a
// budget check always sees exactly what was spent, including calls made by an
// attempt that crashed before its checkpoint.

export function tokensOf(usage) {
  return {
    input: Math.max(0, Math.round(Number(usage?.input_tokens ?? 0)) || 0),
    output: Math.max(0, Math.round(Number(usage?.output_tokens ?? 0)) || 0),
  };
}

export async function recordModelCall({ ownerId, runId, stepId = null, purpose, adapter, fallbackFrom = null, model = null, usage, usd = 0 }, db = getPool()) {
  const { input, output } = tokensOf(usage);
  const cost = Number.isFinite(Number(usd)) ? Math.max(0, Number(usd)) : 0;
  await db.query(
    `INSERT INTO agent_run_costs (owner_id, run_id, step_id, purpose, adapter, fallback_from, model, input_tokens, output_tokens, usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [ownerId, runId, stepId, purpose, adapter, fallbackFrom, model, input, output, cost]
  );
  // Totals only; never the status, which other modules own.
  const { rows } = await db.query(
    `UPDATE agent_runs r
     SET tokens_used = t.tokens, cost_usd = t.usd
     FROM (SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::int AS tokens, COALESCE(SUM(usd), 0) AS usd
           FROM agent_run_costs WHERE run_id = $1) t
     WHERE r.id = $1
     RETURNING r.tokens_used, r.cost_usd`,
    [runId]
  );
  return { tokens: input + output, usd: cost, runTokens: rows[0]?.tokens_used ?? 0, runUsd: Number(rows[0]?.cost_usd ?? 0) };
}

export async function stepTotals(stepId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::int AS tokens, COALESCE(SUM(usd), 0) AS usd
     FROM agent_run_costs WHERE step_id = $1`,
    [stepId]
  );
  return { tokens: rows[0].tokens, usd: Number(rows[0].usd) };
}

export async function runCosts(runId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT step_id, purpose, adapter, fallback_from, model, input_tokens, output_tokens, usd
     FROM agent_run_costs WHERE run_id = $1 ORDER BY created_at, id`,
    [runId]
  );
  return rows.map((row) => ({ ...row, usd: Number(row.usd) }));
}
