import { getPool } from '../db/pool.js';

export async function logQueryMetrics({
  queryText,
  embeddingLatencyMs,
  retrievalLatencyMs,
  nodesRetrieved,
  tokensInjected,
  tokensAvailable,
  efficiencyRatio,
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO query_metrics
       (query_text, embedding_latency_ms, retrieval_latency_ms, nodes_retrieved,
        tokens_injected, tokens_available, efficiency_ratio)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING query_id`,
    [
      queryText,
      embeddingLatencyMs,
      retrievalLatencyMs,
      nodesRetrieved,
      tokensInjected,
      tokensAvailable,
      efficiencyRatio,
    ]
  );
  return rows[0].query_id;
}
