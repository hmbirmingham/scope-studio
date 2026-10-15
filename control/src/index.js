import loadEnv from './config/env.js';
import createApp from './app.js';
import { migrateWithLock } from './db/migrate.js';
import { getPool } from './db/pool.js';

const env = loadEnv();
// A failed migration stops the process before it listens, so the deploy
// fails its health check and the previous release keeps serving.
await migrateWithLock(getPool());

const app = createApp(env);
const port = process.env.PORT || 3101;

app.listen(port, () => {
  console.log(`Scope Studio control plane listening on port ${port}`);
});
