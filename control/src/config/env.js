import 'dotenv/config';

// The control plane holds the secrets a user's machine must never see, so it
// refuses to start on a missing value rather than fall back to a default.
const REQUIRED = ['DATABASE_URL'];

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
  };
}

export default loadEnv;
