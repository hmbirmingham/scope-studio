import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { forgetFailures, deviceToken } from '../../src/control/plan.js';
import { linkUser, meFor, newDeviceToken, startFakeControl } from '../fakeControl.js';
import { registeredSession, startServer } from '../helpers.js';

// /api/control and /api/billing against the stand-in control plane: one local
// user's link is never visible to or usable by another, a billing failure is
// reported as a billing failure, and a control plane that fails /v1/me is not
// asked again on every request.

describe('control and billing routes', () => {
  let server;
  let control;

  // A fresh local user signed in to a control-plane account, with its /v1/me
  // answer cached and known to the stand-in.
  async function linkedUser(plan, email) {
    const api = await registeredSession(server.base);
    const id = (await api('GET', '/api/auth/session')).data.userId;
    const me = meFor(plan, { email });
    const token = await linkUser(server.pool, id, plan, { me });
    control.state.me.set(token, me);
    return { api, id, token, email };
  }
  async function freshUser() {
    const api = await registeredSession(server.base);
    return { api, id: (await api('GET', '/api/auth/session')).data.userId };
  }
  const requestsWith = (token) => control.state.requests.filter((r) => r.auth === `Bearer ${token}`);

  before(async () => {
    control = await startFakeControl();
    process.env.CONTROL_URL = control.url;
    server = await startServer();
  });

  beforeEach(() => {
    control.state.requests = [];
    control.state.meFailure = null;
    control.state.billingFailure = null;
    control.state.devices = [{ id: 'device-1', label: 'this one', current: true }];
    forgetFailures();
  });

  after(async () => {
    delete process.env.CONTROL_URL;
    await server.close();
    await control.close();
  });

  describe("one user's link is theirs alone", () => {
    test('status and billing show another user nothing of it', async () => {
      const a = await linkedUser('engineer', 'a@scope.test');
      const b = await freshUser();

      const status = (await b.api('GET', '/api/control/status')).data;
      assert.deepEqual([status.signedIn, status.plan, status.account, status.pending], [false, 'free', null, null]);
      const billing = (await b.api('GET', '/api/billing')).data;
      assert.deepEqual([billing.signedIn, billing.plan, billing.email, billing.hasSubscription], [false, 'free', null, false]);
      assert.ok(!JSON.stringify([status, billing]).includes('a@scope.test'));
      assert.equal(requestsWith(a.token).length, 0, "nothing B did used A's token");

      // A, meanwhile, is still who they were.
      const own = (await a.api('GET', '/api/control/status')).data;
      assert.deepEqual([own.signedIn, own.plan, own.account.email], [true, 'engineer', 'a@scope.test']);
    });

    test("checkout and the portal for another user are refused as signed out and never use the other user's token", async () => {
      const a = await linkedUser('student', 'a@scope.test');
      const b = await freshUser();
      for (const [path, body] of [['/api/billing/checkout', { plan: 'engineer' }], ['/api/billing/portal', {}]]) {
        const refused = await b.api('POST', path, body);
        assert.deepEqual([refused.status, refused.data.code], [401, 'signed_out'], path);
      }
      assert.equal(control.state.requests.length, 0, 'the control plane was not asked at all');

      const checkout = await a.api('POST', '/api/billing/checkout', { plan: 'engineer' });
      assert.equal(checkout.status, 200);
      assert.equal(requestsWith(a.token).filter((r) => r.path === '/v1/billing/checkout').length, 1);
    });

    test("signing out signs out only the caller: another user's link and device stay", async () => {
      const a = await linkedUser('engineer', 'a@scope.test');
      const b = await freshUser();
      assert.deepEqual((await b.api('POST', '/api/control/signout')).data, { signedOut: false, revoked: false });
      assert.equal(await deviceToken(a.id), a.token);
      assert.equal(control.state.devices.length, 1, 'no device was revoked');
      assert.equal(requestsWith(a.token).length, 0);
      assert.equal((await a.api('GET', '/api/control/status')).data.plan, 'engineer');
    });

    test("a sign-in under way belongs to the user who started it: others cannot see, cancel or finish it", async () => {
      const a = await freshUser();
      const b = await freshUser();
      const tokens = { 'code-a': newDeviceToken(), 'code-b': newDeviceToken() };
      control.state.exchange = ({ code }) => {
        const token = tokens[code];
        if (!token) return null;
        const email = code === 'code-a' ? 'a@scope.test' : 'b@scope.test';
        control.state.me.set(token, meFor('student', { email }));
        return { token, account: { id: `acct-${code}`, email, plan: 'student', devMode: false } };
      };
      try {
        const startedA = (await a.api('POST', '/api/control/signin')).data;
        assert.ok(startedA.url);
        assert.equal((await b.api('GET', '/api/control/status')).data.pending, null, "B does not see A's sign-in");

        // B cancelling cancels nothing of A's.
        assert.equal((await b.api('DELETE', '/api/control/signin')).status, 204);
        assert.equal((await a.api('GET', '/api/control/status')).data.pending.url, startedA.url);

        // B's own sign-in gets its own port and state; B's state does not
        // finish A's flow, and the code it carries is never exchanged there.
        const startedB = (await b.api('POST', '/api/control/signin')).data;
        const paramsA = new URL(startedA.url).searchParams;
        const paramsB = new URL(startedB.url).searchParams;
        assert.notEqual(paramsA.get('redirect_uri'), paramsB.get('redirect_uri'));
        assert.notEqual(paramsA.get('state'), paramsB.get('state'));
        const crossed = new URL(paramsA.get('redirect_uri'));
        crossed.searchParams.set('code', 'code-b');
        crossed.searchParams.set('state', paramsB.get('state'));
        assert.equal((await fetch(crossed)).status, 400);
        assert.equal(control.state.requests.filter((r) => r.path === '/v1/auth/token').length, 0);
        assert.ok((await a.api('GET', '/api/control/status')).data.pending, "A's sign-in is still waiting");

        // B finishing its own sign-in links B, and only B.
        const back = new URL(paramsB.get('redirect_uri'));
        back.searchParams.set('code', 'code-b');
        back.searchParams.set('state', paramsB.get('state'));
        assert.equal((await fetch(back)).status, 200);
        assert.equal(await deviceToken(b.id), tokens['code-b']);
        assert.equal(await deviceToken(a.id), null, 'A is not signed in by B finishing');
        const statusB = (await b.api('GET', '/api/control/status')).data;
        assert.deepEqual([statusB.signedIn, statusB.account.email], [true, 'b@scope.test']);
        const statusA = (await a.api('GET', '/api/control/status')).data;
        assert.equal(statusA.signedIn, false);
        assert.ok(statusA.pending, "A's own sign-in is still the one waiting for A");
      } finally {
        await a.api('DELETE', '/api/control/signin');
        await b.api('DELETE', '/api/control/signin');
        control.state.exchange = null;
      }
    });
  });

  describe('billing errors', () => {
    test('a billing failure with /v1/me answering is reported as a billing failure, not the account service offline', async () => {
      const a = await linkedUser('student', 'a@scope.test');
      control.state.billingFailure = { status: 502, body: { error: 'The payment provider did not answer. Try again shortly.', code: 'stripe_error' } };
      const billing = (await a.api('GET', '/api/billing')).data;
      assert.deepEqual([billing.signedIn, billing.online, billing.configured, billing.plan], [true, true, false, 'student']);
      assert.deepEqual(billing.billingError, { error: 'The payment provider did not answer. Try again shortly.', code: 'stripe_error' });
      assert.equal(await deviceToken(a.id), a.token, 'still signed in');
    });

    test('billing not configured is not an error, and an unreachable billing call is the service offline', async () => {
      const a = await linkedUser('student', 'a@scope.test');
      control.state.billingFailure = { status: 503, body: { error: 'Billing is not configured on this server.', code: 'billing_not_configured' } };
      const unconfigured = (await a.api('GET', '/api/billing')).data;
      assert.deepEqual([unconfigured.online, unconfigured.configured, unconfigured.billingError], [true, false, null]);

      control.state.billingFailure = 'network';
      const dropped = (await a.api('GET', '/api/billing')).data;
      assert.deepEqual([dropped.online, dropped.configured, dropped.billingError], [false, false, null]);
    });

    test('a working billing call reports the subscription and no error', async () => {
      const a = await linkedUser('student', 'a@scope.test');
      const billing = (await a.api('GET', '/api/billing')).data;
      assert.deepEqual([billing.online, billing.configured, billing.hasSubscription, billing.billingError], [true, true, true, null]);
    });

    test('a 401 from billing signs the engine out', async () => {
      const a = await linkedUser('student', 'a@scope.test');
      control.state.billingFailure = { status: 401, body: { error: 'Sign in to Scope Studio again on this device.', code: 'unauthenticated' } };
      const response = await a.api('GET', '/api/billing');
      assert.deepEqual([response.status, response.data.code], [401, 'signed_out']);
      assert.equal(await deviceToken(a.id), null);
    });
  });

  describe('a failing control plane', () => {
    test('after /v1/me fails, billing does not ask again, and neither does the next request for a while', async () => {
      const a = await linkedUser('engineer', 'a@scope.test');
      control.state.meFailure = { status: 500, body: { error: 'Something went wrong.', code: 'internal' } };

      // Billing forces a refresh; it fails, and /v1/billing is not tried after it.
      const billing = (await a.api('GET', '/api/billing')).data;
      assert.deepEqual([billing.signedIn, billing.online, billing.configured], [true, false, false]);
      assert.equal(requestsWith(a.token).filter((r) => r.path === '/v1/me').length, 1);
      assert.equal(requestsWith(a.token).filter((r) => r.path === '/v1/billing').length, 0);

      // The plan cached a moment ago is still within its TTL, so it still counts.
      const status = (await a.api('GET', '/api/control/status?refresh=1')).data;
      assert.deepEqual([status.signedIn, status.online, status.plan], [true, true, 'engineer']);
      await a.api('GET', '/api/billing');
      assert.equal(requestsWith(a.token).length, 1, 'no second request inside the failure window');

      // Another user's refresh is not held back by A's failure.
      control.state.meFailure = null;
      const b = await linkedUser('student', 'b@scope.test');
      assert.equal((await b.api('GET', '/api/control/status?refresh=1')).data.plan, 'student');
      assert.equal(requestsWith(b.token).filter((r) => r.path === '/v1/me').length, 1);
    });
  });

  test('with CONTROL_URL unset, a signed-in user with a fresh cached plan is Free and not configured', async () => {
    const a = await linkedUser('engineer', 'a@scope.test');
    delete process.env.CONTROL_URL;
    try {
      const status = (await a.api('GET', '/api/control/status')).data;
      assert.deepEqual([status.configured, status.plan, status.reason, status.online], [false, 'free', 'not_configured', false]);
      const billing = (await a.api('GET', '/api/billing')).data;
      assert.deepEqual([billing.accountsConfigured, billing.online, billing.configured], [false, false, false]);
      const usage = (await a.api('GET', '/api/usage')).data;
      assert.equal(usage.plan, 'free');
    } finally {
      process.env.CONTROL_URL = control.url;
    }
    assert.equal(control.state.requests.length, 0);
  });
});
