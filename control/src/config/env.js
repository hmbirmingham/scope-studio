import 'dotenv/config';

// The control plane holds the secrets a user's machine must never see, so it
// refuses to start on a missing value rather than fall back to a default.
const REQUIRED = ['DATABASE_URL', 'CONTROL_SESSION_SECRET'];

function loadEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'See control/.env.example for how to obtain each one. Refusing to start with a generated or default value.'
    );
  }

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL,
    sessionSecret: process.env.CONTROL_SESSION_SECRET,
  };
}

// The emails allowed to sign in with dev mode. Read on every call rather than
// once at start-up, so a device's dev mode is re-checked against the list on
// each request and taking someone off it ends their dev mode at once.
export function devModeEmails(env = process.env) {
  return new Set(
    (env.DEV_MODE_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

export default loadEnv;
