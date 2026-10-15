import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrateWithLock } from '../../src/db/migrate.js';
import '../helpers.js';

// A throwaway database, so two "replicas" can race on an empty schema.
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const name = `scope_control_migrate_${process.pid}`;
let fresh;

before(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  fresh = new pg.Pool({ connectionString: url.toString(), max: 6 });
});

after(async () => {
  await fresh.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});

test('two replicas starting at once apply each migration exactly once', async () => {
  const applied = [];
  const log = (line) => applied.push(line);
  await Promise.all([migrateWithLock(fresh, { log }), migrateWithLock(fresh, { log })]);

  const { rows } = await fresh.query('SELECT name FROM schema_migrations ORDER BY name');
  assert.ok(rows.length >= 4);
  assert.equal(applied.length, rows.length, 'no migration was applied twice');
  const { rows: locks } = await fresh.query(`SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory'`);
  assert.equal(locks[0].held, 0, 'the lock is released afterwards');
});
