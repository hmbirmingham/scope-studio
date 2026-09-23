import 'dotenv/config';
import createApp from '../src/app.js';
import loadEnv from '../src/config/env.js';
import { buildCentroids } from '../src/db/build-centroids.js';
import { migrate } from '../src/db/migrate.js';
import { getPool } from '../src/db/pool.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres']);

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL is required to run tests (see .env.example)');
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
  await pool.query(
    'TRUNCATE nodes, node_relationships, query_metrics, query_context_nodes, users, session CASCADE'
  );

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

export function session(base) {
  let cookie = '';
  return async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
}

export async function registeredSession(base) {
  const api = session(base);
  await api('POST', '/api/auth/register', {
    email: `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'hunter2!',
  });
  return api;
}

export async function ollamaAvailable() {
  try {
    const url = process.env.OLLAMA_URL || 'http://localhost:11434';
    const response = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureCentroids(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS count FROM task_centroids');
  if (rows[0].count === 0) await buildCentroids(pool, { log: () => {} });
}
