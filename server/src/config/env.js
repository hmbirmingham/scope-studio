import 'dotenv/config';

const REQUIRED = ['SESSION_SECRET', 'BASE_URL'];

function loadEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'See .env.example for how to obtain each one. Refusing to start with a generated or default value.'
    );
  }

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    sessionSecret: process.env.SESSION_SECRET,
    baseUrl: process.env.BASE_URL,
    databaseUrl: process.env.DATABASE_URL,
  };
}

export default loadEnv;
