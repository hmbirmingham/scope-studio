import loadEnv from './config/env.js';
import createApp from './app.js';
import { createScheduler, createWorker, setRunQueuedListener, stopWithin } from './workspace/runner/index.js';

const env = loadEnv();
const app = createApp(env);
const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`Scope Studio server listening on port ${port}`);
});

// The agent runner works in the background of the engine process. Tests
// create their own workers and schedulers, so none is started there.
if (env.nodeEnv !== 'test') {
  const workers = Number.parseInt(process.env.WORKSPACE_WORKERS ?? '', 10);
  const worker = createWorker({
    concurrency: Number.isInteger(workers) && workers > 0 ? workers : 1,
    // The engine cannot tell a captive portal from the internet cheaply, so it
    // trusts the user: WORKSPACE_OFFLINE=1 keeps every run off the network.
    online: () => process.env.WORKSPACE_OFFLINE !== '1',
  });
  const scheduler = createScheduler({ onQueued: () => worker.poke() });
  setRunQueuedListener(() => worker.poke());
  worker.start();
  scheduler.start();

  // On a normal shutdown each run in flight is handed back to the queue at
  // its next step boundary; on a crash its lease simply expires. The wait for
  // a boundary is bounded, since a step may be a long test suite: after it
  // the engine exits and the remaining leases expire as after a crash.
  const shutdown = async () => {
    const outcome = await stopWithin([scheduler, worker]);
    if (outcome === 'timed_out') console.warn('agent worker: runs still in flight will resume from their last checkpoint');
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
