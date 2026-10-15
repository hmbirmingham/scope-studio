import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { capabilitiesFor } from '../auth/capabilities.js';
import { clientIp } from '../auth/clientIp.js';
import { effectivePlan, isDevModeEmail } from '../auth/devMode.js';
import { isLoopbackRedirect, redirectWithCode } from '../auth/loopback.js';
import {
  AUTH_CODE_TTL_MS,
  CODE_CHALLENGE_METHOD,
  isCodeChallenge,
  newAuthCode,
  verifierMatches,
} from '../auth/pkce.js';
import { browserSession, destroySession, regenerateSession, saveSession, SESSION_COOKIE } from '../auth/session.js';
import { createLoginThrottle } from '../auth/throttle.js';
import { hashToken, newDeviceToken } from '../auth/tokens.js';
import {
  monthlyAnswerLimit,
  planFor,
  platformModel,
  weeklyAllowanceUsd,
} from '../billing/plans.js';
import { sendError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { requireDevice } from '../middleware/requireDevice.js';
import {
  consumeAuthCode,
  createAccount,
  createAuthCode,
  createDevice,
  findAccountByEmail,
  findAccountById,
  listDevices,
  revokeDevice,
} from '../models/accounts.js';
import { allowanceWeekStart, answerMonthStart, freesUpNext, usageSince } from '../models/ledger.js';
import { notifyDevLogin } from '../notify/index.js';
import { renderSigninError, renderSigninPage, signinPageCsp } from '../pages/signin.js';

// Mounted at the root: routes here declare their full paths (see API.md).
const router = Router();

// The cookie session is attached route by route, only where a browser is the
// caller; the engine's bearer-token routes below never read or write it.
const browser = browserSession();
// Built per request so the pool is resolved after start-up, not at import.
const device = (req, res, next) => requireDevice()(req, res, next);
const throttle = createLoginThrottle();

const MIN_PASSWORD_LENGTH = 10;
// scrypt's cost grows with its input, so an absurd "password" is refused
// before it is hashed.
const MAX_PASSWORD_LENGTH = 1024;
const MAX_LABEL_LENGTH = 100;
const MAX_STATE_LENGTH = 512;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');
const isEmail = (email) => email.length <= 254 && EMAIL_SHAPE.test(email);
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const iso = (date) => (date ? new Date(date).toISOString() : null);
const roundUsd = (value, places) => Number(value.toFixed(places));

// A label is shown in the device list and in dev-login notices, so it is kept
// short and free of control characters.
function cleanLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
  return label || null;
}

// Checked against a throwaway hash when the email is unknown, so a wrong
// email and a wrong password take the same time to refuse.
let unknownAccountHash;
const unknownHash = () => (unknownAccountHash ??= hashPassword(randomBytes(16).toString('hex')));

// A fresh session id on every sign-in, so an id planted before sign-in is
// never the one that ends up signed in.
async function startBrowserSession(req, account, devMode) {
  await regenerateSession(req);
  req.session.accountId = account.id;
  req.session.devMode = devMode;
  await saveSession(req);
}

function devModeRefused(res) {
  return sendError(res, 403, 'dev_mode_not_allowed', 'Developer sign-in is not enabled for this email.');
}

// ---- Browser: sign-in page and session ----------------------------------

// The engine's hand-off parameters, validated before the page is shown, so a
// broken or foreign link fails here rather than after a password is typed.
// With none of them the page is a plain sign-in, for the billing pages.
function engineParams(query) {
  const read = (name) => (typeof query[name] === 'string' ? query[name] : undefined);
  const redirectUri = read('redirect_uri');
  const state = read('state');
  const codeChallenge = read('code_challenge');
  const method = read('code_challenge_method');
  const label = cleanLabel(read('label')) ?? '';

  if (redirectUri === undefined && state === undefined && codeChallenge === undefined) {
    return { engine: {} };
  }
  if (!isLoopbackRedirect(redirectUri)) {
    return { error: 'This sign-in link does not point back to the Scope Studio app on this computer.' };
  }
  if ((method !== undefined && method !== CODE_CHALLENGE_METHOD) || !isCodeChallenge(codeChallenge)) {
    return { error: 'This sign-in link is missing its security check.' };
  }
  if (!state || state.length > MAX_STATE_LENGTH) {
    return { error: 'This sign-in link is incomplete.' };
  }
  return { engine: { redirect_uri: redirectUri, state, code_challenge: codeChallenge, label } };
}

router.get('/signin', (req, res) => {
  const nonce = randomBytes(16).toString('base64');
  res.set({
    'Content-Security-Policy': signinPageCsp(nonce),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.type('html');

  const { engine, error } = engineParams(req.query);
  if (error) return res.status(400).send(renderSigninError({ nonce, message: error }));
  res.send(renderSigninPage({ nonce, engine }));
});

router.post('/v1/accounts', browser, async (req, res) => {
  const body = bodyOf(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const devMode = body.dev_mode === true;

  if (!isEmail(email)) return sendError(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return sendError(res, 400, 'weak_password', `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (devMode && !isDevModeEmail(email)) return devModeRefused(res);

  const account = await createAccount({ email, passwordHash: hashPassword(password) });
  if (!account) return sendError(res, 409, 'email_taken', 'An account with this email already exists. Sign in instead.');

  await startBrowserSession(req, account, devMode);
  res.status(201).json({ id: account.id, email: account.email });
});

router.post('/v1/auth/login', browser, async (req, res) => {
  const body = bodyOf(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const devMode = body.dev_mode === true;

  if (!email || !password) return sendError(res, 400, 'invalid_request', 'Enter your email and password.');
  if (throttle.isBlocked(email)) {
    return sendError(res, 429, 'too_many_attempts', 'Too many failed sign-ins for this email. Wait 15 minutes and try again.');
  }

  const account = await findAccountByEmail(email);
  const passwordOk =
    password.length <= MAX_PASSWORD_LENGTH && verifyPassword(password, account?.password_hash ?? unknownHash());
  if (!account || !passwordOk) {
    throttle.recordFailure(email);
    return sendError(res, 401, 'invalid_credentials', 'That email and password do not match an account.');
  }
  throttle.reset(email);

  // Checked only after the password, so the answer never tells a stranger
  // which emails are on the allowlist.
  if (devMode && !isDevModeEmail(email)) return devModeRefused(res);

  await startBrowserSession(req, account, devMode);
  res.json({ id: account.id, email: account.email });
});

router.post('/v1/auth/logout', browser, async (req, res) => {
  if (req.session) await destroySession(req);
  res.clearCookie(SESSION_COOKIE);
  res.status(204).end();
});

// ---- Loopback hand-off to the engine (PKCE) ------------------------------

router.post('/v1/auth/authorize', browser, async (req, res) => {
  const account = req.session?.accountId ? await findAccountById(req.session.accountId) : null;
  if (!account) return sendError(res, 401, 'unauthenticated', 'Sign in first.');

  const body = bodyOf(req);
  const { redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: method } = body;
  if (!isLoopbackRedirect(redirectUri)) {
    return sendError(res, 400, 'invalid_redirect_uri', 'The app must receive sign-in on this computer (127.0.0.1 or localhost).');
  }
  if ((method !== undefined && method !== CODE_CHALLENGE_METHOD) || !isCodeChallenge(codeChallenge)) {
    return sendError(res, 400, 'invalid_code_challenge', 'The sign-in request needs an S256 code challenge.');
  }
  if (typeof state !== 'string' || !state || state.length > MAX_STATE_LENGTH) {
    return sendError(res, 400, 'invalid_state', 'The sign-in request is missing its state.');
  }

  // Re-checked here as well as at sign-in: the allowlist may have changed
  // while the page was open.
  const devMode = req.session.devMode === true;
  if (devMode && !isDevModeEmail(account.email)) return devModeRefused(res);

  const code = newAuthCode();
  await createAuthCode({
    codeHash: hashToken(code),
    accountId: account.id,
    codeChallenge,
    redirectUri,
    label: cleanLabel(body.label),
    devMode,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  res.json({ redirect: redirectWithCode(redirectUri, { code, state }) });
});

router.post('/v1/auth/token', async (req, res) => {
  const { code, code_verifier: verifier } = bodyOf(req);
  if (typeof code !== 'string' || !code || code.length > 256 || typeof verifier !== 'string') {
    return sendError(res, 400, 'invalid_request', 'Send the sign-in code and its verifier.');
  }

  // Unknown, used, expired and wrong-verifier codes get one answer, so a
  // caller learns nothing about which it hit.
  const grant = await consumeAuthCode(hashToken(code));
  if (!grant || !verifierMatches(verifier, grant.code_challenge)) {
    return sendError(res, 400, 'invalid_grant', 'This sign-in code is not valid any more. Sign in again from the app.');
  }

  const devMode = grant.dev_mode && isDevModeEmail(grant.email);
  const token = newDeviceToken();
  const ip = clientIp(req);
  const created = await createDevice({
    accountId: grant.account_id,
    tokenHash: hashToken(token),
    label: grant.label,
    devMode,
    audit: { email: grant.email, ip },
  });

  if (devMode) {
    // The audit row is already committed; a provider outage must not turn a
    // recorded sign-in into a failed one.
    try {
      await notifyDevLogin({ email: grant.email, label: grant.label, ip, at: created.created_at });
    } catch (err) {
      console.error(`Dev-mode sign-in notification failed: ${err.message}`);
    }
  }

  const { plan } = effectivePlan({ plan: grant.plan, email: grant.email, devMode });
  res.json({ token, account: { id: grant.account_id, email: grant.email, plan, devMode } });
});

// ---- Engine: who am I, and my devices ------------------------------------

const NO_LIMITS = {
  monthlyAnswers: null,
  answersUsed: null,
  weeklyAllowanceUsd: null,
  weeklySpentUsd: null,
  freesUpNext: null,
};

router.get('/v1/me', device, async (req, res) => {
  const { id, email, plan, devMode } = req.account;
  const account = await findAccountById(id);
  const now = new Date();
  const allowanceUsd = weeklyAllowanceUsd(plan);

  // Only platform-paid plans have a budget to report; on the others every
  // limit is null rather than a misleading zero.
  let limits = NO_LIMITS;
  let spentUsd = 0;
  if (planFor(plan).platformPaid) {
    const [week, month, next] = await Promise.all([
      usageSince(id, allowanceWeekStart(now)),
      usageSince(id, answerMonthStart(now)),
      freesUpNext(id, now),
    ]);
    spentUsd = week.spentUsd;
    limits = {
      monthlyAnswers: monthlyAnswerLimit(plan),
      answersUsed: month.answers,
      // The allowance is a display figure to the cent; spend keeps sub-cent
      // detail so a few small answers do not read as nothing spent.
      weeklyAllowanceUsd: roundUsd(allowanceUsd, 2),
      weeklySpentUsd: roundUsd(spentUsd, 4),
      freesUpNext: next && { amountUsd: roundUsd(next.amountUsd, 4), at: next.at.toISOString() },
    };
  }

  res.json({
    account: { id, email, plan, devMode },
    capabilities: capabilitiesFor(plan),
    limits,
    nextModel: {
      default: platformModel(plan, { spentUsd, allowanceUsd }),
      hard: platformModel(plan, { hard: true, spentUsd, allowanceUsd }),
    },
    billing: {
      status: account?.billing_status ?? null,
      renewsAt: iso(account?.billing_renews_at),
      cancelAt: iso(account?.billing_cancel_at),
    },
  });
});

router.get('/v1/devices', device, async (req, res) => {
  const devices = await listDevices(req.account.id);
  res.json({
    devices: devices.map((d) => ({
      id: d.id,
      label: d.label,
      createdAt: iso(d.created_at),
      lastUsedAt: iso(d.last_used_at),
      current: d.id === req.deviceId,
    })),
  });
});

router.delete('/v1/devices/:id', device, async (req, res) => {
  const revoked = await revokeDevice(req.account.id, req.params.id);
  if (!revoked) return sendError(res, 404, 'not_found', 'No device with that id is signed in to your account.');
  res.status(204).end();
});

export default router;
