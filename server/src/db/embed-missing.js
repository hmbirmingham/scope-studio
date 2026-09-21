import 'dotenv/config';
import { embedDocument } from '../lib/embeddings.js';
import { listNodesMissingEmbedding, setNodeEmbedding } from '../models/nodeStore.js';
import { getPool } from './pool.js';

async function run() {
  const nodes = await listNodesMissingEmbedding();
  for (const node of nodes) {
    await setNodeEmbedding(node.id, await embedDocument(node.content));
  }
  console.log(`Embedded ${nodes.length} node(s)`);
  await getPool().end();
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
