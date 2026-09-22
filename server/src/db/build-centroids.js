import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { embedQuery } from '../lib/embeddings.js';
import { TASK_EXAMPLES } from '../retrieval/taskExamples.js';
import { getPool } from './pool.js';

function meanUnitVector(vectors) {
  const dims = vectors[0].length;
  const mean = new Array(dims).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dims; i++) mean[i] += vector[i] / vectors.length;
  }
  const norm = Math.hypot(...mean);
  return mean.map((value) => value / norm);
}

export async function buildCentroids(pool, { log = console.log } = {}) {
  for (const [task, examples] of Object.entries(TASK_EXAMPLES)) {
    const vectors = await Promise.all(examples.map(embedQuery));
    const centroid = meanUnitVector(vectors);
    await pool.query(
      `INSERT INTO task_centroids (task, embedding, example_count, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (task) DO UPDATE SET
         embedding = EXCLUDED.embedding,
         example_count = EXCLUDED.example_count,
         updated_at = now()`,
      [task, `[${centroid.join(',')}]`, examples.length]
    );
    log(`${task}: centroid from ${examples.length} examples`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = getPool();
  buildCentroids(pool)
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
