import express from 'express';
import session from 'express-session';
import authRouter from './routes/auth.js';

function createApp(env) {
  const app = express();

  app.use(express.json());
  app.use(
    session({
      secret: env.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: env.nodeEnv === 'production',
        httpOnly: true,
      },
    })
  );

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRouter);

  return app;
}

export default createApp;
