import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';

// The id may be minted by the caller: a streaming answer hands it to the client
// on the first line and writes this row only after the last token.
export async function logQueryMetrics({
  queryId = randomUUID(),
  queryText,
  sessionId,
  ownerId,
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
  routingDecision = null,
  routingDecisionMs = null,
  routingReason = null,
  modelUsed = null,
  ttftMs = null,
  totalResponseMs = null,
  outputTokens = null,
  costUsd = null,
}, db = getPool()) {
  const { rows } = await db.query(
    `INSERT INTO query_metrics
       (query_id, query_text, session_id, owner_id, tier, embedding_latency_ms,
        retrieval_latency_ms, nodes_retrieved, tokens_injected, tokens_available,
        efficiency_ratio, inferred_task_type, task_confidence, superseded_nodes_demoted,
        source_type_boost_applied, routing_decision, routing_decision_ms, routing_reason,
        model_used, ttft_ms, total_response_ms, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22, $23)
     RETURNING query_id`,
    [
      queryId,
      queryText,
      sessionId ?? null,
      ownerId ?? null,
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
      routingDecision,
      routingDecisionMs,
      routingReason,
      modelUsed,
      ttftMs,
      totalResponseMs,
      outputTokens,
      costUsd,
    ]
  );
  return rows[0].query_id;
}

export async function logContextNodes(queryId, entries, db = getPool()) {
  if (entries.length === 0) return;
  await db.query(
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
  await getPool().query(
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
