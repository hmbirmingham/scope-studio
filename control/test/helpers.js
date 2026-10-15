import 'dotenv/config';
import createApp from '../src/app.js';
import loadEnv from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { getPool } from '../src/db/pool.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres']);

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL is required to run tests (see control/.env.example)');
}
const host = new URL(testUrl).hostname;
if (!LOCAL_HOSTS.has(host)) {
  throw new Error(`Refusing to run tests against non-local database host "${host}"`);
}
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';

export async function startServer() {
  const pool = getPool();
  await migrate(pool, { log: () => {} });
  await pool.query('TRUNCATE accounts, device_tokens, usage_ledger CASCADE');

  const app = createApp(loadEnv());
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const base = `http://localhost:${server.address().port}`;

  return {
    base,
    pool,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

export async function createAccount(pool, { email = 'test@scope.local', plan = 'free' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (email, password_hash, plan) VALUES ($1, 'unused', $2) RETURNING id, created_at`,
    [email, plan]
  );
  return rows[0];
}
