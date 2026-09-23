import { getPool } from '../db/pool.js';

// What a user actually costs to serve. Metered tiers are priced against this,
// so it reads from the recorded per-query cost rather than an estimate.
export async function usageSummary(ownerId, { days = 7 } = {}) {
  const pool = getPool();
  const window = `${Number(days)} days`;

  const { rows: totals } = await pool.query(
    `SELECT count(*)::int AS queries,
            count(*) FILTER (WHERE routing_decision = 'cloud')::int AS cloud_queries,
            COALESCE(sum(cost_usd), 0)::float8 AS spend,
            COALESCE(sum(output_tokens), 0)::int AS output_tokens
     FROM query_metrics
     WHERE owner_id = $1 AND created_at > now() - $2::interval`,
    [ownerId, window]
  );

  const { rows: byModel } = await pool.query(
    `SELECT model_used AS model, count(*)::int AS queries,
            COALESCE(sum(cost_usd), 0)::float8 AS spend
     FROM query_metrics
     WHERE owner_id = $1 AND created_at > now() - $2::interval AND model_used IS NOT NULL
     GROUP BY model_used
     ORDER BY spend DESC, queries DESC`,
    [ownerId, window]
  );

  const total = totals[0];
  const perDay = total.spend / Number(days);
  return {
    windowDays: Number(days),
    queries: total.queries,
    cloudQueries: total.cloud_queries,
    spendUsd: total.spend,
    outputTokens: total.output_tokens,
    averageCloudCostUsd: total.cloud_queries > 0 ? total.spend / total.cloud_queries : 0,
    // What this user would cost over a month at the current rate — the number
    // a metered tier's price has to clear.
    projectedMonthlyUsd: perDay * 30,
    byModel,
  };
}
