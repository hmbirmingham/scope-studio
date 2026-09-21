import { getPool } from '../db/pool.js';

export async function logQueryMetrics({
  queryText,
  sessionId,
  tier,
  embeddingLatencyMs,
  retrievalLatencyMs,
  nodesRetrieved,
  tokensInjected,
  tokensAvailable,
  efficiencyRatio,
  inferredTaskType,
  taskConfidence,
  supersededNodesDemoted,
  sourceTypeBoostApplied,
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO query_metrics
       (query_text, session_id, tier, embedding_latency_ms, retrieval_latency_ms,
        nodes_retrieved, tokens_injected, tokens_available, efficiency_ratio,
        inferred_task_type, task_confidence, superseded_nodes_demoted,
        source_type_boost_applied)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING query_id`,
    [
      queryText,
      sessionId ?? null,
      tier,
      embeddingLatencyMs,
      retrievalLatencyMs,
      nodesRetrieved,
      tokensInjected,
      tokensAvailable,
      efficiencyRatio,
      inferredTaskType,
      taskConfidence,
      supersededNodesDemoted,
      sourceTypeBoostApplied,
    ]
  );
  return rows[0].query_id;
}

export async function logContextNodes(queryId, entries) {
  if (entries.length === 0) return;
  const pool = getPool();
  await pool.query(
    `INSERT INTO query_context_nodes (query_id, node_id, position, score, decay_lambda)
     SELECT $1, node_id, position, score, decay_lambda
     FROM unnest($2::uuid[], $3::int[], $4::real[], $5::real[])
       AS t(node_id, position, score, decay_lambda)`,
    [
      queryId,
      entries.map((entry) => entry.nodeId),
      entries.map((entry) => entry.position),
      entries.map((entry) => entry.score),
      entries.map((entry) => entry.decayLambda),
    ]
  );
}

// A re-ask within 60s is the implicit "that answer failed" signal (ADR §7):
// stamp it on the previous query in the same session.
export async function markFollowUp(sessionId, currentQueryId) {
  const pool = getPool();
  await pool.query(
    `UPDATE query_metrics
     SET follow_up_within_60s = (now() - created_at) < interval '60 seconds'
     WHERE query_id = (
       SELECT query_id FROM query_metrics
       WHERE session_id = $1 AND query_id <> $2 AND follow_up_within_60s IS NULL
       ORDER BY created_at DESC
       LIMIT 1
     )`,
    [sessionId, currentQueryId]
  );
}

export async function recordFeedback(queryId, sessionId, useful) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE query_metrics SET user_confirmed_useful = $3
     WHERE query_id = $1 AND session_id = $2`,
    [queryId, sessionId, useful]
  );
  if (rowCount === 0) return false;

  if (useful) {
    await pool.query(
      `UPDATE nodes
       SET last_confirmed_useful = now(), confirmed_useful_count = confirmed_useful_count + 1
       WHERE id IN (SELECT node_id FROM query_context_nodes WHERE query_id = $1)`,
      [queryId]
    );
  }
  return true;
}
