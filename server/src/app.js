import express from 'express';
import session from 'express-session';
import authRouter from './routes/auth.js';
import nodesRouter from './routes/nodes.js';
import githubPluginRouter from './routes/plugins/github.js';
import queryRouter from './routes/query.js';

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
  app.use('/api/nodes', nodesRouter);
  app.use('/api/plugins/github', githubPluginRouter);
  app.use('/api/query', queryRouter);

  return app;
}

export default createApp;
