import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyDevLogin, setNotifyProvider } from '../../src/notify/index.js';
import { createResendProvider, resendProviderFromEnv } from '../../src/notify/resend.js';

// Obviously fake values: nothing here is, or looks like, a real credential.
const FAKE_ENV = {
  RESEND_API_KEY: 'fake-resend-key-for-tests',
  NOTIFY_FROM_EMAIL: 'from@example.test',
  DEV_LOGIN_NOTIFY_EMAIL: 'ops@example.test',
};
const event = { email: 'dev@example.test', label: 'Test Mac', ip: '127.0.0.1', at: new Date('2026-10-15T09:00:00Z') };

function quietLog() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

afterEach(() => setNotifyProvider(null));

test('a configured provider is sent the dev-mode sign-in', async () => {
  const sent = [];
  setNotifyProvider({ send: async (message) => sent.push(message) });
  const log = quietLog();
  assert.deepEqual(await notifyDevLogin(event, { env: FAKE_ENV, log }), { sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ops@example.test');
  assert.match(sent[0].subject, /dev@example\.test/);
  assert.match(sent[0].text, /Test Mac/);
  assert.match(sent[0].text, /127\.0\.0\.1/);
  assert.match(sent[0].text, /2026-10-15T09:00:00\.000Z/);
  assert.equal(log.warnings.length, 0);
});

test('without full configuration it logs one warning and skips, with no default address', async () => {
  for (const missing of Object.keys(FAKE_ENV)) {
    const env = { ...FAKE_ENV, [missing]: '' };
    const log = quietLog();
    assert.deepEqual(await notifyDevLogin(event, { env, log }), { sent: false }, missing);
    assert.equal(log.warnings.length, 1, missing);
  }
});

test('a recipient is still required when a provider is injected', async () => {
  const sent = [];
  setNotifyProvider({ send: async (message) => sent.push(message) });
  const log = quietLog();
  assert.deepEqual(await notifyDevLogin(event, { env: {}, log }), { sent: false });
  assert.equal(sent.length, 0);
});

test('the Resend provider exists only with a key and a sender', () => {
  assert.equal(resendProviderFromEnv({}), null);
  assert.equal(resendProviderFromEnv({ RESEND_API_KEY: FAKE_ENV.RESEND_API_KEY }), null);
  assert.equal(resendProviderFromEnv({ NOTIFY_FROM_EMAIL: FAKE_ENV.NOTIFY_FROM_EMAIL }), null);
  assert.equal(resendProviderFromEnv(FAKE_ENV, { fetchImpl: () => {} }).name, 'resend');
});

test('the Resend provider posts the message with its key, through the fetch it is given', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const provider = createResendProvider({ apiKey: FAKE_ENV.RESEND_API_KEY, from: FAKE_ENV.NOTIFY_FROM_EMAIL, fetchImpl });
  await provider.send({ to: 'ops@example.test', subject: 'hello', text: 'body' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${FAKE_ENV.RESEND_API_KEY}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    from: 'from@example.test',
    to: ['ops@example.test'],
    subject: 'hello',
    text: 'body',
  });

  const failing = createResendProvider({ apiKey: 'fake', from: 'from@example.test', fetchImpl: async () => ({ ok: false, status: 422 }) });
  await assert.rejects(failing.send({ to: 'ops@example.test', subject: 's', text: 't' }), /Resend answered 422/);
});
