import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import loadEnv from '../../src/config/env.js';

const saved = process.env.DATABASE_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = saved;
});

test('refuses to start without a database rather than use a default', () => {
  delete process.env.DATABASE_URL;
  assert.throws(() => loadEnv(), /DATABASE_URL.*Refusing to start/s);
});
