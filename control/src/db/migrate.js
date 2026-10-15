import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPool } from './pool.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(pool, { log = console.log } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await pool.query('SELECT name FROM schema_migrations');
  const appliedNames = new Set(applied.map((row) => row.name));

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedNames.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`Applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

// An arbitrary constant naming the control plane's migration lock.
const MIGRATION_LOCK = 7_340_211;

// Migrations run when the server starts, before it listens: Railway's
// pre-deploy hook is part of a config format it is retiring, and the health
// check already keeps traffic away until the server is up. A session-level
// advisory lock makes a second replica starting at the same moment wait for
// the first, then find nothing left to apply.
export async function migrateWithLock(pool, options) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      await migrate(pool, options);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = getPool();
  migrateWithLock(pool)
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
