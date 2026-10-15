import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import loadEnv from '../config/env.js';
import { getPool } from '../db/pool.js';

const PgSessionStore = connectPgSimple(session);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'scope_control.sid';

// The cookie session behind the sign-in and billing pages. It is built on
// first use rather than at import, because the routers are imported before
// the environment (and in tests, the test database) is in place. It is only
// attached to the browser routes, so an engine's API calls never touch the
// session table.
export function browserSession() {
  let middleware;
  return function browserSessionMiddleware(req, res, next) {
    middleware ??= createSession(loadEnv());
    return middleware(req, res, next);
  };
}

function createSession(env) {
  const production = env.nodeEnv === 'production';
  return session({
    name: SESSION_COOKIE,
    store: new PgSessionStore({
      pool: getPool(),
      tableName: 'control_session',
      // The prune timer would keep test processes alive after the server closes.
      pruneSessionInterval: env.nodeEnv === 'test' ? false : 15 * 60,
    }),
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    // Railway terminates TLS in front of the service, so in production the
    // forwarded protocol is what says whether the browser connection is secure.
    proxy: production,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      maxAge: WEEK_MS,
    },
  });
}

// express-session's callbacks, as promises the route handlers can await.
export function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

export function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

export function destroySession(req) {
  return new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
}
