import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_PLUGINS, capabilitiesFor, plansWithoutPlugins, pluginsFor } from '../../src/auth/capabilities.js';
import { clientIp } from '../../src/auth/clientIp.js';
import { DEV_MODE_PLAN, effectivePlan } from '../../src/auth/devMode.js';
import { isLoopbackRedirect, redirectWithCode } from '../../src/auth/loopback.js';
import { challengeFor, isCodeChallenge, isCodeVerifier, newAuthCode, verifierMatches } from '../../src/auth/pkce.js';
import { createLoginThrottle } from '../../src/auth/throttle.js';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';

test('only loopback http redirects with an explicit port are accepted', () => {
  for (const ok of [
    'http://127.0.0.1:53682/callback',
    'http://localhost:8123/',
    'http://localhost:8123/cb?keep=1',
  ]) {
    assert.equal(isLoopbackRedirect(ok), true, ok);
  }
  for (const bad of [
    'https://127.0.0.1:53682/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:0/callback',
    'http://evil.example/callback',
    'http://localhost.evil.example:8080/',
    'http://localhost:8080@evil.example/',
    'http://user:pass@localhost:8080/',
    'http://[::1]:8080/',
    'http://localhost:8080/#fragment',
    'javascript:alert(1)',
    '/relative',
    '',
    undefined,
    ['http://localhost:8080/'],
    `http://localhost:8080/${'a'.repeat(3000)}`,
  ]) {
    assert.equal(isLoopbackRedirect(bad), false, String(bad));
  }
});

test('the redirect keeps the engine query and adds the code and state, encoded', () => {
  const url = new URL(redirectWithCode('http://127.0.0.1:5000/cb?keep=1', { code: 'abc', state: 'a&b=c' }));
  assert.equal(url.searchParams.get('keep'), '1');
  assert.equal(url.searchParams.get('code'), 'abc');
  assert.equal(url.searchParams.get('state'), 'a&b=c');
});

test('S256 verifiers match only their own challenge', () => {
  const verifier = 'v'.repeat(43);
  const challenge = challengeFor(verifier);
  assert.equal(isCodeChallenge(challenge), true);
  assert.equal(verifierMatches(verifier, challenge), true);
  assert.equal(verifierMatches('w'.repeat(43), challenge), false);
  assert.equal(verifierMatches(verifier, verifier), false, 'plain is not accepted');
  assert.equal(isCodeVerifier('short'), false);
  assert.equal(isCodeVerifier('x'.repeat(129)), false);
  // RFC 7636 appendix B.
  assert.equal(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.notEqual(newAuthCode(), newAuthCode());
});

test('the login throttle blocks after ten failures inside fifteen minutes, then forgets', () => {
  let clock = 0;
  const throttle = createLoginThrottle({ now: () => clock });
  for (let i = 0; i < 9; i += 1) throttle.recordFailure('a@example.test');
  assert.equal(throttle.isBlocked('a@example.test'), false);
  throttle.recordFailure('a@example.test');
  assert.equal(throttle.isBlocked('a@example.test'), true);
  assert.equal(throttle.isBlocked('b@example.test'), false, 'per email');
  clock += 15 * 60 * 1000 + 1;
  assert.equal(throttle.isBlocked('a@example.test'), false);
  throttle.recordFailure('a@example.test');
  throttle.reset('a@example.test');
  assert.equal(throttle.isBlocked('a@example.test'), false);
});

test('passwords use the engine scheme and a malformed stored hash is just a wrong password', () => {
  const stored = hashPassword('correct horse battery');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('wrong horse battery', stored), false);
  assert.equal(verifyPassword('anything', 'unused'), false);
  assert.equal(verifyPassword('anything', undefined), false);
});

test('dev mode gives the Engineer plan only while the email is still allowlisted', () => {
  const env = { DEV_MODE_EMAILS: 'dev@example.test' };
  assert.deepEqual(effectivePlan({ plan: 'free', email: 'DEV@example.test', devMode: true }, env), {
    plan: DEV_MODE_PLAN,
    devMode: true,
  });
  assert.deepEqual(effectivePlan({ plan: 'free', email: 'dev@example.test', devMode: true }, {}), { plan: 'free', devMode: false });
  assert.deepEqual(effectivePlan({ plan: 'student', email: 'dev@example.test', devMode: false }, env), {
    plan: 'student',
    devMode: false,
  });
});

test('every plan lists its plug-ins, and all of them get every shipped plug-in today', () => {
  assert.deepEqual(plansWithoutPlugins(), []);
  for (const plan of Object.keys(PLAN_PLUGINS)) assert.deepEqual(pluginsFor(plan), ['github', 'local_folder']);
  assert.deepEqual(pluginsFor('no_such_plan'), PLAN_PLUGINS.free);
  assert.deepEqual(capabilitiesFor('key_pro'), { chooseCloud: true, autoCloud: true, plugins: ['github', 'local_folder'] });
  assert.deepEqual(capabilitiesFor('free'), { chooseCloud: false, autoCloud: false, plugins: ['github', 'local_folder'] });
});

test('the audit address trusts only the hop the proxy appended, and only behind the proxy', () => {
  const req = (xff, remote = '10.0.0.5') => ({ get: () => xff, socket: { remoteAddress: remote } });
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.9'), { behindProxy: true }), '203.0.113.9');
  assert.equal(clientIp(req(undefined), { behindProxy: true }), '10.0.0.5');
  assert.equal(clientIp(req('6.6.6.6'), { behindProxy: false }), '10.0.0.5');
});
