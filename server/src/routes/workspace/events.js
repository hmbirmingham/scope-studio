import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import { formatSse, workspaceEvents } from '../../workspace/events.js';

// The activity stream (docs/architecture/agent-workspace.md). One connection
// per open activity tab, for one run or for all of the user's runs; a
// reconnect sends Last-Event-ID and receives what it missed.
const router = Router();
router.use(requireAuth);

const HEARTBEAT_MS = 15_000;
const RETRY_MS = 3_000;

router.get('/', (req, res) => {
  const runId = typeof req.query.runId === 'string' && req.query.runId ? req.query.runId : null;
  const lastEventId = req.get('Last-Event-ID') ?? null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Reverse proxies otherwise buffer the stream and deliver it in bursts.
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: ${RETRY_MS}\n: connected\n\n`);

  const write = (text) => {
    // Throwing tells the bus to drop this subscriber.
    if (res.writableEnded || res.destroyed) throw new Error('stream closed');
    res.write(text);
  };
  const unsubscribe = workspaceEvents.subscribe(
    { ownerId: req.session.userId, runId, lastEventId },
    (event) => write(formatSse(event))
  );
  // Proxies close idle connections; a comment line keeps this one open.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
