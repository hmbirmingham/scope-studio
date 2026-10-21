import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { ControlError, controlUrl, readJson } from '../../src/control/client.js';
import { FAILURE_TTL_MS, PLAN_TTL_MS, controlState, forgetFailures } from '../../src/control/plan.js';
import { MAX_ATTEMPTS, PlatformUnavailable, parseSse, platformCall, sourcesOf } from '../../src/control/platform.js';
import { challengeFor, newState, newVerifier, signinUrl, startSignIn, stateMatches } from '../../src/control/signin.js';
import { openToken, sealToken } from '../../src/control/tokenBox.js';
import { platformAdapter } from '../../src/workspace/modelPort.js';
import { doneEvent, meFor, startFakeControl } from '../fakeControl.js';

const SECRET = 'test-session-secret-not-real';
const TOKEN = `sst_${'a'.repeat(43)}`;

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function bytes(...chunks) {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk);
  })();
}

const sseResponse = (events, status = 200) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status, headers: { 'Content-Type': 'text/event-stream' } });
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A fetch that answers each call with the next item: a Response, a function of
// the request, or an Error to throw (a network failure). Records every call.
function scriptedFetch(answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, init) : next;
  };
  impl.calls = calls;
  return impl;
}

const base = 'http://control.test';
const messages = [{ role: 'system', content: 'Answer from the context.' }, { role: 'user', content: '## Question\nwhat is it' }];

describe('control plane link: sign-in pieces', () => {
  test('the S256 challenge matches RFC 7636 appendix B', () => {
    assert.equal(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('verifiers and states are fresh, 256-bit and URL-safe; a verifier is a valid RFC 7636 verifier', () => {
    const verifier = newVerifier();
    assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.notEqual(newVerifier(), verifier);
    assert.match(newState(), /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(newState(), newState());
  });

  test('the state check needs the exact value', () => {
    const state = newState();
    assert.equal(stateMatches(state, state), true);
    assert.equal(stateMatches(state, `${state.slice(0, -1)}x`), false);
    assert.equal(stateMatches(state, state.slice(1)), false);
    assert.equal(stateMatches(state, null), false);
    assert.equal(stateMatches(state, undefined), false);
  });

  test('the sign-in link carries the loopback redirect, state and S256 challenge, never the verifier', () => {
    const verifier = newVerifier();
    const url = new URL(signinUrl('https://control.scope.test', { redirectUri: 'http://127.0.0.1:5123/callback', state: 'st', challenge: challengeFor(verifier), label: 'Scope Studio on test' }));
    assert.equal(url.origin + url.pathname, 'https://control.scope.test/signin');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5123/callback');
    assert.equal(url.searchParams.get('state'), 'st');
    assert.equal(url.searchParams.get('code_challenge'), challengeFor(verifier));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!url.toString().includes(verifier));
  });

  test('CONTROL_URL is optional, trimmed of trailing slashes, and only http(s)', () => {
    assert.equal(controlUrl({}), null);
    assert.equal(controlUrl({ CONTROL_URL: '' }), null);
    assert.equal(controlUrl({ CONTROL_URL: 'https://control.scope.test/' }), 'https://control.scope.test');
    assert.equal(controlUrl({ CONTROL_URL: 'ftp://control.scope.test' }), null);
    assert.equal(controlUrl({ CONTROL_URL: 'not a url' }), null);
  });

  test('a control-plane refusal keeps its status, code and sentence; a broken success is an error, not null', async () => {
    await assert.rejects(readJson(jsonResponse(402, { error: 'Used up.', code: 'allowance_exhausted', freesUpNext: { amountUsd: 1, at: null } })), (err) =>
      err instanceof ControlError && err.status === 402 && err.code === 'allowance_exhausted' && err.message === 'Used up.' && err.freesUpNext.amountUsd === 1);
    await assert.rejects(readJson(new Response('<html>', { status: 200 })), (err) => err.code === 'control_bad_response');
    assert.equal(await readJson(new Response(null, { status: 204 })), null);
  });

  test('the stored token is sealed: unreadable without the secret, and tamper-evident', () => {
    const sealed = sealToken(TOKEN, SECRET);
    assert.ok(!sealed.includes(TOKEN));
    assert.equal(openToken(sealed, SECRET), TOKEN);
    assert.equal(openToken(sealed, 'another-secret-not-real'), null, 'a rotated secret reads as signed out');
    const [v, iv, tag, body] = sealed.split('.');
    assert.equal(openToken([v, iv, tag, `${body.slice(0, -2)}AA`].join('.'), SECRET), null);
    assert.equal(openToken('garbage', SECRET), null);
    assert.notEqual(sealToken(TOKEN, SECRET), sealed, 'a fresh nonce every time');
  });
});

describe('control plane link: the loopback callback', () => {
  async function flow(exchange, extra = {}) {
    const control = await startFakeControl();
    control.state.exchange = exchange;
    const saved = [];
    let outcome;
    const ended = new Promise((resolve) => {
      outcome = resolve;
    });
    const started = await startSignIn(`owner-${Math.random()}`, {
      base: control.url,
      save: async (link) => saved.push(link),
      onComplete: outcome,
      ...extra,
    });
    const url = new URL(started.url);
    return { control, saved, ended, started, url, state: url.searchParams.get('state'), challenge: url.searchParams.get('code_challenge') };
  }

  test('listens on 127.0.0.1 only, and a correct redirect is exchanged with the verifier and stored', async () => {
    let sent;
    const run = await flow((body) => {
      sent = body;
      return { token: TOKEN, account: { id: 'acct-1', email: 'a@b.c', plan: 'student', devMode: false } };
    });
    try {
      const redirect = new URL(run.started.redirectUri);
      assert.equal(redirect.hostname, '127.0.0.1');
      assert.equal(redirect.pathname, '/callback');
      assert.notEqual(redirect.port, '');

      const response = await fetch(`${run.started.redirectUri}?code=one-time-code&state=${run.state}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Signed in/);
      assert.equal((await run.ended).ok, true);
      assert.equal(sent.code, 'one-time-code');
      assert.equal(challengeFor(sent.code_verifier), run.challenge, 'the verifier behind the challenge');
      assert.equal(run.saved.length, 1);
      assert.equal(run.saved[0].token, TOKEN);
      // The port is closed once the flow ends.
      await assert.rejects(fetch(`${run.started.redirectUri}?code=again&state=${run.state}`));
    } finally {
      await run.control.close();
    }
  });

  test('a wrong or missing state is refused and the real redirect still works afterwards', async () => {
    const run = await flow(() => ({ token: TOKEN, account: { id: 'acct-1', email: 'a@b.c', plan: 'free' } }));
    try {
      for (const query of ['code=x&state=wrong', 'code=x', `code=x&state=${run.state}x`]) {
        const response = await fetch(`${run.started.redirectUri}?${query}`);
        assert.equal(response.status, 400, query);
        assert.ok(!(await response.text()).includes('code=x'), 'nothing from the request is reflected');
      }
      assert.equal(run.control.state.requests.length, 0, 'no exchange was attempted');
      assert.equal((await fetch(`${run.started.redirectUri.replace('/callback', '/other')}?state=${run.state}`)).status, 404);
      const ok = await fetch(`${run.started.redirectUri}?code=real&state=${run.state}`);
      assert.equal(ok.status, 200);
      assert.equal(run.saved.length, 1);
    } finally {
      await run.control.close();
    }
  });

  test('a rejected code ends the flow and stores nothing', async () => {
    const run = await flow(() => null);
    try {
      const response = await fetch(`${run.started.redirectUri}?code=spent&state=${run.state}`);
      assert.equal(response.status, 502);
      const outcome = await run.ended;
      assert.deepEqual([outcome.ok, outcome.reason], [false, 'invalid_grant']);
      assert.equal(run.saved.length, 0);
    } finally {
      await run.control.close();
    }
  });

  test('a redirect without a code (the person cancelled) ends the flow', async () => {
    const run = await flow(() => ({ token: TOKEN, account: { id: 'a', email: 'a@b.c' } }));
    try {
      const response = await fetch(`${run.started.redirectUri}?error=access_denied&state=${run.state}`);
      assert.equal(response.status, 400);
      assert.deepEqual(await run.ended, { ok: false, reason: 'no_code' });
      assert.equal(run.saved.length, 0);
    } finally {
      await run.control.close();
    }
  });

  test('an unfinished sign-in expires and stops listening', async () => {
    const run = await flow(() => null, { ttlMs: 30 });
    try {
      assert.deepEqual(await run.ended, { ok: false, reason: 'expired' });
      await assert.rejects(fetch(`${run.started.redirectUri}?code=late&state=${run.state}`));
    } finally {
      await run.control.close();
    }
  });

  test('without a control plane configured, sign-in refuses to start', async () => {
    await assert.rejects(startSignIn('owner', { base: null }), (err) => err.code === 'control_not_configured');
  });
});

describe('control plane link: plan cache', () => {
  // An in-memory stand-in for control_links.
  function memoryStore(link) {
    const store = {
      link,
      async getLink() {
        return store.link;
      },
      async saveMe(ownerId, me, fetchedAt) {
        store.link = { ...store.link, me, meFetchedAt: fetchedAt };
      },
      async deleteLink() {
        store.link = null;
      },
    };
    return store;
  }
  const linked = (me, fetchedAt) => ({ ownerId: 'o', token: TOKEN, email: 'a@b.c', devMode: false, me, meFetchedAt: fetchedAt });
  // Every test here uses owner 'o'; a failure one test leaves must not hold
  // back the next one's refresh.
  beforeEach(() => forgetFailures());

  test('signed out is Free, and no request is made', async () => {
    const fetchImpl = scriptedFetch([]);
    const state = await controlState('o', { store: memoryStore(null), fetchImpl });
    assert.deepEqual([state.signedIn, state.plan], [false, 'free']);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('a cached answer younger than the TTL is used without asking; an older one is refreshed', async () => {
    process.env.CONTROL_URL = base;
    try {
      const now = Date.now();
      const store = memoryStore(linked(meFor('engineer'), new Date(now - PLAN_TTL_MS + 1000)));
      const fetchImpl = scriptedFetch([jsonResponse(200, meFor('student'))]);
      const cached = await controlState('o', { store, fetchImpl, now });
      assert.deepEqual([cached.plan, cached.online], ['engineer', true]);
      assert.equal(fetchImpl.calls.length, 0);

      const later = await controlState('o', { store, fetchImpl, now: now + 2000 });
      assert.deepEqual([later.plan, later.online], ['student', true], 'expired: asked again, and the plan changed');
      assert.equal(fetchImpl.calls.length, 1);
      assert.equal(fetchImpl.calls[0].url, `${base}/v1/me`);
      assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(store.link.me.account.plan, 'student', 'the new answer is cached');
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('refresh on demand asks even when the cache is fresh', async () => {
    process.env.CONTROL_URL = base;
    try {
      const store = memoryStore(linked(meFor('engineer'), new Date()));
      const fetchImpl = scriptedFetch([jsonResponse(200, meFor('key_pro'))]);
      assert.equal((await controlState('o', { store, fetchImpl, refresh: true })).plan, 'key_pro');
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('offline with an expired cache runs as Free, keeps the last answer for display, and does not sign out', async () => {
    process.env.CONTROL_URL = base;
    try {
      const store = memoryStore(linked(meFor('engineer'), new Date(Date.now() - 2 * PLAN_TTL_MS)));
      const fetchImpl = scriptedFetch([new TypeError('fetch failed')]);
      const state = await controlState('o', { store, fetchImpl });
      assert.deepEqual([state.signedIn, state.online, state.stale, state.plan, state.reason], [true, false, true, 'free', 'offline']);
      assert.equal(state.account.plan, 'engineer', 'still shown');
      assert.ok(store.link, 'the sign-in is kept');
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('a control plane failing with a 5xx is treated like offline', async () => {
    process.env.CONTROL_URL = base;
    try {
      const store = memoryStore(linked(null, null));
      const fetchImpl = scriptedFetch([jsonResponse(500, { error: 'boom', code: 'internal' })]);
      const state = await controlState('o', { store, fetchImpl });
      assert.deepEqual([state.online, state.plan], [false, 'free']);
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('a revoked token (401) forgets the sign-in', async () => {
    process.env.CONTROL_URL = base;
    try {
      const store = memoryStore(linked(meFor('student'), new Date(0)));
      const fetchImpl = scriptedFetch([jsonResponse(401, { error: 'Sign in again.', code: 'unauthenticated' })]);
      const state = await controlState('o', { store, fetchImpl });
      assert.deepEqual([state.signedIn, state.plan, state.reason], [false, 'free', 'signed_out']);
      assert.equal(store.link, null);
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('with no CONTROL_URL an expired cache cannot be refreshed: Free', async () => {
    delete process.env.CONTROL_URL;
    const store = memoryStore(linked(meFor('engineer'), new Date(0)));
    const state = await controlState('o', { store, fetchImpl: scriptedFetch([]) });
    assert.deepEqual([state.plan, state.reason], ['free', 'not_configured']);
  });

  test('with no CONTROL_URL even a fresh cached answer grants nothing: Free, not configured', async () => {
    delete process.env.CONTROL_URL;
    const store = memoryStore(linked(meFor('engineer'), new Date()));
    const fetchImpl = scriptedFetch([]);
    for (const refresh of [false, true]) {
      const state = await controlState('o', { store, fetchImpl, refresh });
      assert.deepEqual(
        [state.configured, state.signedIn, state.online, state.plan, state.reason],
        [false, true, false, 'free', 'not_configured']
      );
      assert.equal(state.account.plan, 'engineer', 'the last answer is still shown');
    }
    assert.equal(fetchImpl.calls.length, 0);
    assert.ok(store.link.me, 'the cache is kept for when CONTROL_URL comes back');
  });

  test('after a failed refresh the control plane is not asked again for a while', async () => {
    process.env.CONTROL_URL = base;
    try {
      const now = Date.now();
      const store = memoryStore(linked(meFor('engineer'), new Date(now - 2 * PLAN_TTL_MS)));
      const fetchImpl = scriptedFetch([new TypeError('fetch failed'), jsonResponse(200, meFor('student'))]);
      const first = await controlState('o', { store, fetchImpl, now });
      assert.deepEqual([first.plan, first.reason, first.refreshFailed], ['free', 'offline', true]);
      assert.equal(fetchImpl.calls.length, 1);

      // Within the window: answered at once, without a request, forced or not.
      for (const refresh of [false, true]) {
        const held = await controlState('o', { store, fetchImpl, now: now + FAILURE_TTL_MS - 1, refresh });
        assert.deepEqual([held.plan, held.online, held.reason, held.refreshFailed], ['free', false, 'offline', true]);
      }
      assert.equal(fetchImpl.calls.length, 1, 'no request inside the window');

      // After it: asked again, and the answer clears the failure.
      const later = await controlState('o', { store, fetchImpl, now: now + FAILURE_TTL_MS });
      assert.deepEqual([later.plan, later.online, later.refreshFailed], ['student', true, false]);
      assert.equal(fetchImpl.calls.length, 2);
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('a failed forced refresh keeps serving a plan still within its TTL', async () => {
    process.env.CONTROL_URL = base;
    try {
      const now = Date.now();
      // Confirmed with two seconds of its TTL left.
      const store = memoryStore(linked(meFor('engineer'), new Date(now - PLAN_TTL_MS + 2000)));
      const fetchImpl = scriptedFetch([jsonResponse(503, { error: 'busy', code: 'unavailable' })]);
      const state = await controlState('o', { store, fetchImpl, now, refresh: true });
      assert.deepEqual([state.plan, state.online, state.stale, state.refreshFailed], ['engineer', true, false, true]);
      // Still within the TTL and the failure window: the same, with no request.
      const again = await controlState('o', { store, fetchImpl, now: now + 1000, refresh: true });
      assert.deepEqual([again.plan, again.online], ['engineer', true]);
      assert.equal(fetchImpl.calls.length, 1);
      // Once the TTL runs out inside the window, the plan is Free until the control plane answers.
      const expired = await controlState('o', { store, fetchImpl, now: now + 2000 });
      assert.deepEqual([expired.plan, expired.online, expired.reason], ['free', false, 'offline']);
      assert.equal(fetchImpl.calls.length, 1);
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('a new sign-in (a new token) is not held back by the old link\'s failure', async () => {
    process.env.CONTROL_URL = base;
    try {
      const now = Date.now();
      const store = memoryStore(linked(null, null));
      const fetchImpl = scriptedFetch([new TypeError('fetch failed'), jsonResponse(200, meFor('student'))]);
      assert.equal((await controlState('o', { store, fetchImpl, now })).reason, 'offline');
      store.link = { ...linked(null, null), token: `sst_${'b'.repeat(43)}` };
      const state = await controlState('o', { store, fetchImpl, now: now + 1 });
      assert.deepEqual([state.plan, state.online], ['student', true]);
      assert.equal(fetchImpl.calls.length, 2);
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('a 401 is not remembered as a failure: it signs out at once', async () => {
    process.env.CONTROL_URL = base;
    try {
      const now = Date.now();
      const store = memoryStore(linked(meFor('student'), new Date(0)));
      const fetchImpl = scriptedFetch([new TypeError('fetch failed'), jsonResponse(401, { error: 'Sign in again.', code: 'unauthenticated' })]);
      assert.equal((await controlState('o', { store, fetchImpl, now })).reason, 'offline');
      const state = await controlState('o', { store, fetchImpl, now: now + FAILURE_TTL_MS });
      assert.deepEqual([state.signedIn, state.reason], [false, 'signed_out']);
      assert.equal(store.link, null);
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('a burst of reads after the cache expires shares one refresh', async () => {
    process.env.CONTROL_URL = base;
    try {
      const store = memoryStore(linked(meFor('student'), new Date(0)));
      const fetchImpl = scriptedFetch([jsonResponse(200, meFor('student'))]);
      const states = await Promise.all([1, 2, 3].map(() => controlState('o', { store, fetchImpl })));
      assert.ok(states.every((state) => state.plan === 'student'));
      assert.equal(fetchImpl.calls.length, 1);
    } finally {
      delete process.env.CONTROL_URL;
    }
  });

  test('a plan name the engine does not know is Free', async () => {
    process.env.CONTROL_URL = base;
    try {
      const store = memoryStore(linked({ ...meFor('student'), account: { plan: 'platinum' } }, new Date()));
      const state = await controlState('o', { store });
      assert.deepEqual([state.online, state.plan], [true, 'free']);
    } finally {
      delete process.env.CONTROL_URL;
    }
  });
});

describe('control plane link: platform answers', () => {
  test('server-sent events are parsed across chunk boundaries, CRLF, comments and multi-line data', async () => {
    const events = await collect(parseSse(bytes(': keep-alive\n\n', 'data: {"text":"Hel', 'lo"}\r\n\r\n', 'event: x\ndata: {"a":\ndata: 1}\n\n', 'data: {"done":true}')));
    assert.deepEqual(events, [{ text: 'Hello' }, { a: 1 }, { done: true }]);
  });

  test('sources are the valid plug-in names behind the packed nodes, each once, at most 16', () => {
    const nodes = [{ source: 'github' }, { source: 'github' }, { source: 'local_folder' }, { source: 'Bad Name' }, {}, null];
    assert.deepEqual(sourcesOf(nodes), ['github', 'local_folder']);
    assert.equal(sourcesOf(Array.from({ length: 30 }, (_, i) => ({ source: `p${i}` }))).length, 16);
  });

  test('an answer streams in the ModelPort shape and sends only what the contract allows', async () => {
    const fetchImpl = scriptedFetch([sseResponse([{ text: 'Platform ' }, { text: 'answer.' }, doneEvent()])]);
    const call = platformCall({ token: TOKEN, messages, cacheMarker: '## Question', hard: true, sources: ['github'], fetchImpl, base });
    const out = await collect(call.stream());
    assert.deepEqual(out.slice(0, 2), [{ text: 'Platform ' }, { text: 'answer.' }]);
    const done = out.at(-1);
    assert.equal(done.done, true);
    assert.equal(done.model, 'claude-sonnet-5');
    assert.equal(done.costUsd, 0.0042);
    assert.equal(done.usage.output_tokens, 40);

    const [request] = fetchImpl.calls;
    assert.equal(request.url, `${base}/v1/cloud/messages`);
    assert.equal(request.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(Object.keys(request.body).sort(), ['cacheMarker', 'hard', 'messages', 'requestId', 'sources']);
    assert.equal(request.body.hard, true);
    assert.ok(request.body.requestId.length >= 8 && request.body.requestId.length <= 128);
  });

  test('without a token it refuses before anything is sent', async () => {
    const fetchImpl = scriptedFetch([]);
    await assert.rejects(collect(platformCall({ token: null, messages, fetchImpl, base }).stream()), (err) =>
      err instanceof PlatformUnavailable && err.code === 'platform_unavailable' && err.reason === 'signed_out');
    await assert.rejects(collect(platformCall({ token: TOKEN, messages, fetchImpl, base: null }).stream()), (err) => err.reason === 'not_configured');
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('every attempt has a fresh requestId: a network failure and a busy control plane are retried on new ids', async () => {
    const fetchImpl = scriptedFetch([
      new TypeError('fetch failed'),
      jsonResponse(429, { error: 'Two answers already.', code: 'too_many_streams' }),
      sseResponse([{ text: 'ok' }, doneEvent()]),
    ]);
    const call = platformCall({ token: TOKEN, messages, fetchImpl, base, delays: [0] });
    const out = await collect(call.stream());
    assert.equal(out.at(-1).done, true);
    const ids = fetchImpl.calls.map((c) => c.body.requestId);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, 'no id is ever sent twice');
    assert.deepEqual(call.requestIds, ids);
  });

  test('an answer that fails before its first word is retried on a new id; after text it is not', async () => {
    const early = scriptedFetch([sseResponse([{ error: 'failed', code: 'upstream_error' }]), sseResponse([{ text: 'second' }, doneEvent()])]);
    const call = platformCall({ token: TOKEN, messages, fetchImpl: early, base, delays: [0] });
    assert.equal((await collect(call.stream()))[0].text, 'second');
    assert.notEqual(early.calls[0].body.requestId, early.calls[1].body.requestId);

    const late = scriptedFetch([sseResponse([{ text: 'half' }, { error: 'The cloud answer stopped partway through.', code: 'upstream_error' }])]);
    const seen = [];
    await assert.rejects(
      (async () => {
        for await (const event of platformCall({ token: TOKEN, messages, fetchImpl: late, base, delays: [0] }).stream()) seen.push(event);
      })(),
      (err) => err.code === 'upstream_error' && /partway/.test(err.message)
    );
    assert.deepEqual(seen, [{ text: 'half' }]);
    assert.equal(late.calls.length, 1);
  });

  test('a stream that ends without done counts as a failure', async () => {
    const fetchImpl = scriptedFetch([sseResponse([{ text: 'cut' }])]);
    await assert.rejects(collect(platformCall({ token: TOKEN, messages, fetchImpl, base, delays: [0] }).stream()), (err) => err.code === 'upstream_error');
  });

  test('plan and allowance refusals are not retried and come back as platform_unavailable with the reason', async () => {
    for (const [status, code] of [[402, 'allowance_exhausted'], [402, 'answer_limit_reached'], [403, 'cloud_not_in_plan'], [503, 'platform_cloud_unavailable'], [400, 'field_not_allowed']]) {
      const fetchImpl = scriptedFetch([jsonResponse(status, { error: 'refused', code })]);
      await assert.rejects(platformCall({ token: TOKEN, messages, fetchImpl, base }).open(), (err) =>
        err instanceof PlatformUnavailable && err.code === 'platform_unavailable' && err.reason === code, code);
      assert.equal(fetchImpl.calls.length, 1, code);
    }
    const revoked = scriptedFetch([jsonResponse(401, { error: 'Sign in again.', code: 'unauthenticated' })]);
    await assert.rejects(platformCall({ token: TOKEN, messages, fetchImpl: revoked, base }).open(), (err) => err.reason === 'signed_out');
  });

  test(`offline, it gives up after ${MAX_ATTEMPTS} attempts as platform_unavailable`, async () => {
    const fetchImpl = scriptedFetch(Array.from({ length: MAX_ATTEMPTS }, () => new TypeError('fetch failed')));
    await assert.rejects(platformCall({ token: TOKEN, messages, fetchImpl, base, delays: [0] }).open(), (err) => err.reason === 'offline');
    assert.equal(fetchImpl.calls.length, MAX_ATTEMPTS);
  });

  test("the platform ModelPort adapter reads the user's token, asks for the hard model when planning, and refuses without one", async () => {
    const fetchImpl = scriptedFetch([sseResponse([{ text: 'plan' }, doneEvent({ model: 'claude-opus-5' })])]);
    const port = platformAdapter({ ownerId: 'o', getToken: async () => TOKEN, fetchImpl, base, sources: ['github'] });
    assert.deepEqual([port.name, port.offline], ['platform', false]);
    const out = await collect(port.stream({ messages, purpose: 'plan', maxTokens: 50 }));
    assert.deepEqual(out.map((e) => e.text ?? e.model), ['plan', 'claude-opus-5']);
    assert.equal(fetchImpl.calls[0].body.hard, true);
    assert.equal(fetchImpl.calls[0].body.maxTokens, undefined, 'the control plane decides the ceiling');

    const signedOut = platformAdapter({ ownerId: 'o', getToken: async () => null, fetchImpl, base });
    await assert.rejects(collect(signedOut.stream({ messages, purpose: 'step' })), (err) => err.code === 'platform_unavailable');
    assert.equal(fetchImpl.calls.length, 1);
  });
});
