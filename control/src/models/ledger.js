import { getPool } from '../db/pool.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Records one platform-paid answer. The engine sends a request id with every
// call, so a retry after a dropped connection is charged once, not twice.
// Returns false when the request was already recorded.
export async function recordUsage(
  { accountId, requestId, model, hard = false, inputTokens = 0, outputTokens = 0, webSearches = 0, costUsd, sources = [] },
  pool = getPool()
) {
  const { rowCount } = await pool.query(
    `INSERT INTO usage_ledger
       (account_id, request_id, model, hard, input_tokens, output_tokens, web_searches, cost_usd, sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (request_id) DO NOTHING`,
    [accountId, requestId, model, hard, inputTokens, outputTokens, webSearches, costUsd, sources]
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

// The next spend to leave the rolling week: the oldest answer inside it, and
// the moment it ages out. With no reset day to tell people, this is the
// honest "more allowance on <date>" line. Null when the week holds no spend.
export async function freesUpNext(accountId, now, pool = getPool()) {
  const { rows } = await pool.query(
    `SELECT cost_usd::float8 AS amount_usd, created_at
     FROM usage_ledger
     WHERE account_id = $1 AND created_at >= $2
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [accountId, allowanceWeekStart(now)]
  );
  if (rows.length === 0) return null;
  return { amountUsd: rows[0].amount_usd, at: new Date(rows[0].created_at.getTime() + 7 * DAY_MS) };
}

// Whether a request id has already been charged, by any account. The id is
// unique across the whole ledger, so a repeat would be dropped when its usage
// is recorded: it has to be refused before it streams, or the platform would
// pay for an answer the ledger never counts.
export async function requestRecorded(requestId, pool = getPool()) {
  const { rowCount } = await pool.query('SELECT 1 FROM usage_ledger WHERE request_id = $1', [requestId]);
  return rowCount > 0;
}

// The next answer to leave the rolling month: the oldest one inside it, and
// the moment it ages out, which is when one more answer becomes available
// again. Null when the month holds no answers.
export async function answerFreesUpNext(accountId, now, pool = getPool()) {
  const { rows } = await pool.query(
    `SELECT created_at
     FROM usage_ledger
     WHERE account_id = $1 AND created_at >= $2
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [accountId, answerMonthStart(now)]
  );
  if (rows.length === 0) return null;
  return { answers: 1, at: new Date(rows[0].created_at.getTime() + 30 * DAY_MS) };
}
