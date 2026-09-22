import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { tryEmbedDocument } from '../lib/embeddings.js';
import {
  createNode,
  getNode,
  listNodes,
  updateNode,
  deleteNode,
  createRelationship,
  listRelationships,
} from '../models/nodeStore.js';

const NODE_TYPES = ['repo', 'file', 'decision', 'spec', 'paper', 'datasheet', 'conversation'];
const PRIVACY_LEVELS = ['local', 'cloud'];
const RELATIONSHIP_TYPES = ['depends_on', 'references', 'supersedes', 'caused_by', 'part_of'];

const router = Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const { type, content, project, privacy } = req.body;
  if (!type || !content) {
    return res.status(400).json({ error: 'type and content are required' });
  }
  if (!NODE_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${NODE_TYPES.join(', ')}` });
  }
  if (privacy && !PRIVACY_LEVELS.includes(privacy)) {
    return res.status(400).json({ error: `privacy must be one of: ${PRIVACY_LEVELS.join(', ')}` });
  }

  const embedding = await tryEmbedDocument(content);
  const node = await createNode({
    ownerId: req.session.userId,
    type,
    content,
    embedding,
    project,
    privacy,
    source: 'manual',
  });
  res.status(201).json(node);
});

router.get('/', async (req, res) => {
  const { project, type } = req.query;
  res.json(await listNodes(req.session.userId, { project, type }));
});

router.get('/:id', async (req, res) => {
  const node = await getNode(req.session.userId, req.params.id);
  if (!node) return res.status(404).json({ error: 'node not found' });
  res.json(node);
});

router.patch('/:id', async (req, res) => {
  const { content, project, privacy } = req.body;
  if (privacy && !PRIVACY_LEVELS.includes(privacy)) {
    return res.status(400).json({ error: `privacy must be one of: ${PRIVACY_LEVELS.join(', ')}` });
  }

  const embedding = content ? await tryEmbedDocument(content) : null;
  const node = await updateNode(req.session.userId, req.params.id, { content, embedding, project, privacy });
  if (!node) return res.status(404).json({ error: 'node not found' });
  res.json(node);
});

router.delete('/:id', async (req, res) => {
  const deleted = await deleteNode(req.session.userId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'node not found' });
  res.status(204).end();
});

router.post('/:id/relationships', async (req, res) => {
  const { targetId, type, weight } = req.body;
  if (!targetId || !type) {
    return res.status(400).json({ error: 'targetId and type are required' });
  }
  if (!RELATIONSHIP_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${RELATIONSHIP_TYPES.join(', ')}` });
  }

  try {
    const relationship = await createRelationship(req.session.userId, {
      sourceId: req.params.id,
      targetId,
      type,
      weight,
    });
    if (!relationship) return res.status(404).json({ error: 'node not found' });
    res.status(201).json(relationship);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'relationship already exists' });
    throw err;
  }
});

router.get('/:id/relationships', async (req, res) => {
  res.json(await listRelationships(req.session.userId, req.params.id));
});

export default router;
