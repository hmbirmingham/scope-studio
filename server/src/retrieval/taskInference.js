// Single batch cosine query against stored centroids (ARCHITECTURE.md §3.2):
// no extra model pass, stays inside the retrieval latency budget.
export async function inferTask(pool, queryVector) {
  const { rows } = await pool.query(
    `SELECT task, 1 - (embedding <=> $1::vector) AS similarity
     FROM task_centroids
     ORDER BY similarity DESC`,
    [`[${queryVector.join(',')}]`]
  );
  if (rows.length === 0) return null;
  return { task: rows[0].task, confidence: Number(rows[0].similarity) };
}
