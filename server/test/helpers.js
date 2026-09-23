import 'dotenv/config';
import createApp from '../src/app.js';
import loadEnv from '../src/config/env.js';
import { buildCentroids } from '../src/db/build-centroids.js';
import { migrate } from '../src/db/migrate.js';
import { getPool } from '../src/db/pool.js';
import { TASK_EXAMPLES } from '../src/retrieval/taskExamples.js';

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

// `api.raw` returns the unread Response, for streaming endpoints.
export function session(base) {
  let cookie = '';
  const raw = async (method, path, body, { headers, ...init } = {}) => {
    const response = await fetch(base + path, {
      method,
      // Merged, not replaced: a caller adding one header must not drop the cookie.
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
      ...init,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const api = async (method, path, body) => {
    const response = await raw(method, path, body);
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
  api.raw = raw;
  return api;
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
  if (rows[0].count !== Object.keys(TASK_EXAMPLES).length) {
    await buildCentroids(pool, { log: () => {} });
  }
}
