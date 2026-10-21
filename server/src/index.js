import loadEnv from './config/env.js';
import createApp from './app.js';
import { registerBuiltInPlugins } from './plugins/registry.js';
import { createScheduler, createWorker, setRunQueuedListener } from './workspace/runner/index.js';

const env = loadEnv();
const app = createApp(env);
const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`Scope Studio server listening on port ${port}`);
});

// The agent runner works in the background of the engine process. Tests
// create their own workers and schedulers, so none is started there.
if (env.nodeEnv !== 'test') {
  registerBuiltInPlugins();
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
  // its next step boundary; on a crash its lease simply expires.
  const shutdown = async () => {
    await Promise.allSettled([scheduler.stop(), worker.stop()]);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
