import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import loadEnv, { devModeEmails } from '../../src/config/env.js';

const saved = { DATABASE_URL: process.env.DATABASE_URL, CONTROL_SESSION_SECRET: process.env.CONTROL_SESSION_SECRET };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('refuses to start without a database rather than use a default', () => {
  delete process.env.DATABASE_URL;
  assert.throws(() => loadEnv(), /DATABASE_URL.*Refusing to start/s);
});

test('refuses to start without a session secret rather than invent one', () => {
  process.env.DATABASE_URL = 'postgresql://localhost/unused';
  delete process.env.CONTROL_SESSION_SECRET;
  assert.throws(() => loadEnv(), /CONTROL_SESSION_SECRET.*Refusing to start/s);
});

test('the dev-mode allowlist is comma-separated, trimmed and case-insensitive', () => {
  const emails = devModeEmails({ DEV_MODE_EMAILS: ' Dev@Example.test, ,second@example.test ' });
  assert.deepEqual([...emails], ['dev@example.test', 'second@example.test']);
  assert.equal(devModeEmails({}).size, 0, 'unset means nobody, never a default');
});
