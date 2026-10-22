import { randomBytes } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { tryEmbedDocuments } from '../lib/embeddings.js';
import { hashPassword } from '../lib/password.js';
import { ensureRelationship, upsertNodeByExternalId } from '../models/nodeStore.js';
import { createUser, findUserByEmail } from '../models/userStore.js';
import { buildNewAgent } from '../workspace/agents/agentInput.js';
import { createAgent } from '../workspace/agents/agentStore.js';
import { createTask } from '../workspace/agents/taskStore.js';
import { validateTask } from '../workspace/agents/validation.js';
import { DEMO_AGENT, DEMO_EMAIL, DEMO_NODES, DEMO_PROJECT, DEMO_RELATIONSHIPS, DEMO_TASKS, EXTERNAL_PREFIX } from './content.js';

// Seeds the student demo (docs/demo.md) through the engine's own stores, so
// every row is what the app itself would have written: nodes through the node
// store (with embeddings when Ollama is up), the agent through the same
// validation as POST /api/agents, tasks through the same validation as
// POST /api/tasks.
//
// The demo has an account of its own, and a re-seed resets everything that
// account owns and nothing else: other accounts in the same database are
// never read or changed.

// The tables that hold what an account made in the workspace and on the map.
// Tasks, runs, steps, approvals and run costs go with their agent; node
// relationships go with their nodes. research_items (migration 050) would go
// with its nodes too, and is cleared explicitly so the reset never depends
// on that. A control link (a Scope Studio sign-in made from the demo) is
// cleared so every demo starts signed out: free, local answers only.
const RESET_STATEMENTS = [
  'DELETE FROM agents WHERE owner_id = $1',
  'DELETE FROM agent_roles WHERE owner_id = $1',
  'DELETE FROM research_items WHERE owner_id = $1',
  'DELETE FROM nodes WHERE owner_id = $1',
  'DELETE FROM project_settings WHERE owner_id = $1',
  'DELETE FROM query_metrics WHERE owner_id = $1',
  'DELETE FROM control_links WHERE owner_id = $1',
];

// The demo account signs in through local mode (SCOPE_LOCAL_USER), never with
// a password, so it gets a random one nobody knows; the users table requires
// one.
async function demoUser(email) {
  const existing = await findUserByEmail(email);
  if (existing) return { id: existing.id, email: existing.email, created: false };
  const user = await createUser({ email, passwordHash: hashPassword(randomBytes(32).toString('hex')) });
  return { id: user.id, email: user.email, created: true };
}

export async function resetDemoData(ownerId, db = getPool()) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const statement of RESET_STATEMENTS) await client.query(statement, [ownerId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// `embed: false` skips Ollama entirely (retrieval then runs lexical-only, as
// it does whenever embeddings are missing; `npm run embed` backfills them).
export async function seedDemo({ email = DEMO_EMAIL, embed = true } = {}) {
  const user = await demoUser(email);
  await resetDemoData(user.id);

  const embeddings = embed ? await tryEmbedDocuments(DEMO_NODES.map((node) => node.content)) : DEMO_NODES.map(() => null);
  const ids = new Map();
  for (const [i, node] of DEMO_NODES.entries()) {
    const row = await upsertNodeByExternalId({
      ownerId: user.id,
      type: node.type,
      content: node.content,
      embedding: embeddings[i] ?? null,
      source: 'manual',
      externalId: `${EXTERNAL_PREFIX}${node.key}`,
      project: DEMO_PROJECT,
      privacy: node.privacy,
    });
    ids.set(node.key, row.id);
  }
  for (const [from, to, type] of DEMO_RELATIONSHIPS) {
    await ensureRelationship(user.id, { sourceId: ids.get(from), targetId: ids.get(to), type });
  }

  // The agent reads and writes only the demo project, and stays local.
  const built = await buildNewAgent(user.id, {
    name: DEMO_AGENT.name,
    template: DEMO_AGENT.template,
    level: DEMO_AGENT.level,
    modelPolicy: DEMO_AGENT.modelPolicy,
    color: DEMO_AGENT.color,
    scopes: { read: { projects: [DEMO_PROJECT], sources: ['*'] }, write: { projects: [DEMO_PROJECT] } },
  });
  if (built.rejection) throw new Error(`demo agent refused: ${built.rejection.message}`);
  const agent = await createAgent(user.id, built.agent);

  const tasks = [];
  for (const task of DEMO_TASKS) {
    const checked = validateTask({ ...task, agentId: agent.id, project: DEMO_PROJECT, enabled: true });
    if (checked.error) throw new Error(`demo task refused: ${checked.message}`);
    tasks.push(await createTask(user.id, checked.value));
  }

  return {
    user,
    project: DEMO_PROJECT,
    nodeIds: Object.fromEntries(ids),
    agent,
    tasks,
    embedded: embeddings.filter(Boolean).length,
  };
}
