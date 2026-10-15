import { getPool } from '../db/pool.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Records one platform-paid answer. The engine sends a request id with every
// call, so a retry after a dropped connection is charged once, not twice.
// Returns false when the request was already recorded.
export async function recordUsage(
  { accountId, requestId, model, hard = false, inputTokens = 0, outputTokens = 0, webSearches = 0, costUsd },
  pool = getPool()
) {
  const { rowCount } = await pool.query(
    `INSERT INTO usage_ledger
       (account_id, request_id, model, hard, input_tokens, output_tokens, web_searches, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (request_id) DO NOTHING`,
    [accountId, requestId, model, hard, inputTokens, outputTokens, webSearches, costUsd]
  );
  return rowCount === 1;
}

// When the current allowance week began: a rolling seven days. A calendar or
// signup-anchored week would let an account spend its whole allowance just
// before the reset and again just after; a rolling window caps any seven days
// at one allowance, and spend frees up a day at a time instead of all at once.
export function allowanceWeekStart(now) {
  return new Date(now.getTime() - 7 * DAY_MS);
}

// The monthly answer limit counts a rolling 30 days, matching how the plans
// were priced.
export function answerMonthStart(now) {
  return new Date(now.getTime() - 30 * DAY_MS);
}

// What the platform has spent on an account, and how many answers it paid
// for, since a given moment.
export async function usageSince(accountId, since, pool = getPool()) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(cost_usd), 0)::float8 AS spent_usd, count(*)::int AS answers
     FROM usage_ledger
     WHERE account_id = $1 AND created_at >= $2`,
    [accountId, since]
  );
  return { spentUsd: rows[0].spent_usd, answers: rows[0].answers };
}
