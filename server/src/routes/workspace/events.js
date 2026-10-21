import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import { formatSse, workspaceEvents } from '../../workspace/events.js';

// The activity stream (docs/architecture/agent-workspace.md). One connection
// per open activity tab; a reconnect sends Last-Event-ID and receives what it
// missed for that run.
const router = Router();
router.use(requireAuth);

const HEARTBEAT_MS = 15_000;

router.get('/', (req, res) => {
  const runId = typeof req.query.runId === 'string' && req.query.runId ? req.query.runId : null;
  const afterSeq = Number.parseInt(req.get('Last-Event-ID') ?? '0', 10) || 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const unsubscribe = workspaceEvents.subscribe(
    { ownerId: req.session.userId, runId, afterSeq },
    (event) => res.write(formatSse(event))
  );
  // Proxies close idle connections; a comment line keeps this one open.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
