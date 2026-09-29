import { getPool } from '../db/pool.js';
import { canAutoCloud, canChooseCloud, planFor, platformModel, weeklyAllowanceUsd } from '../billing/plans.js';

// What the platform has paid for this user's cloud answers over the last seven
// days: the figure the weekly allowance is checked against before every
// platform-paid answer.
export async function weeklyPlatformSpend(ownerId, pool = getPool()) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(cost_usd) FILTER (WHERE billed_to = 'platform'), 0)::float8 AS spend
     FROM query_metrics
     WHERE owner_id = $1 AND created_at > now() - interval '7 days'`,
    [ownerId]
  );
  return rows[0].spend;
}

// What a user actually costs to serve. Metered tiers are priced against this,
// so it reads from the recorded per-query cost rather than an estimate.
export async function usageSummary(ownerId, { days = 7, plan = 'free' } = {}) {
  const pool = getPool();
  planFor(plan);
  const window = `${Number(days)} days`;

  const { rows: totals } = await pool.query(
    `SELECT count(*)::int AS queries,
            count(*) FILTER (WHERE routing_decision = 'cloud')::int AS cloud_queries,
            COALESCE(sum(cost_usd), 0)::float8 AS spend,
            -- Only platform spend is margin; a user's own key is their money.
            COALESCE(sum(cost_usd) FILTER (WHERE billed_to = 'platform'), 0)::float8 AS platform_spend,
            COALESCE(sum(cost_usd) FILTER (WHERE billed_to = 'user_key'), 0)::float8 AS user_key_spend,
            COALESCE(sum(output_tokens), 0)::int AS output_tokens
     FROM query_metrics
     WHERE owner_id = $1 AND created_at > now() - $2::interval`,
    [ownerId, window]
  );

  const thisWeek = await weeklyPlatformSpend(ownerId, pool);

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
  const perDay = total.platform_spend / Number(days);
  const allowance = weeklyAllowanceUsd(plan);

  return {
    plan,
    // What this plan may do with the cloud, so the interface can say so before
    // the server refuses.
    chooseCloud: canChooseCloud(plan),
    autoCloud: canAutoCloud(plan),
    windowDays: Number(days),
    queries: total.queries,
    cloudQueries: total.cloud_queries,
    spendUsd: total.spend,
    // The split that decides margin: what the platform paid for, and what ran
    // on the user's own key.
    platformSpendUsd: total.platform_spend,
    userKeySpendUsd: total.user_key_spend,
    outputTokens: total.output_tokens,
    averageCloudCostUsd: total.cloud_queries > 0 ? total.spend / total.cloud_queries : 0,
    // What this user would cost the platform over a month at the current rate —
    // the number a metered price has to clear.
    projectedMonthlyUsd: perDay * 30,
    weekly: allowance === null
      ? { allowanceUsd: null, spentUsd: thisWeek, remainingUsd: null, note: 'runs on the user\'s own key' }
      : allowance === 0
        ? { allowanceUsd: 0, spentUsd: 0, remainingUsd: 0, note: 'local only' }
        : {
            allowanceUsd: allowance,
            spentUsd: thisWeek,
            remainingUsd: Math.max(allowance - thisWeek, 0),
            exhausted: thisWeek >= allowance,
            // Which model the next platform-paid answer would use.
            nextModel: platformModel(thisWeek, allowance),
          },
    byModel,
  };
}
