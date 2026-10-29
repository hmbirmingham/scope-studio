import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import session from 'express-session';
import { getPool } from './db/pool.js';
import authRouter from './routes/auth.js';
import chatRouter from './routes/chat.js';
import editsRouter from './routes/edits.js';
import projectsRouter from './routes/projects.js';
import runsRouter from './routes/runs.js';
import actionsRouter from './routes/actions.js';
import nodesRouter from './routes/nodes.js';
import githubPluginRouter from './routes/plugins/github.js';
import graphRouter from './routes/graph.js';
import queryRouter from './routes/query.js';

const PgSessionStore = connectPgSimple(session);

function createApp(env) {
  const app = express();

  app.use(express.json());
  app.use(
    session({
      store: new PgSessionStore({
        pool: getPool(),
        tableName: 'session',
        // The prune timer would keep test processes alive after the server closes.
        pruneSessionInterval: env.nodeEnv === 'test' ? false : 60,
      }),
      secret: env.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: env.nodeEnv === 'production',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      },
    })
  );

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', authRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/edits', editsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/runs', runsRouter);
  app.use('/api/actions', actionsRouter);
  app.use('/api/graph', graphRouter);
  app.use('/api/nodes', nodesRouter);
  app.use('/api/plugins/github', githubPluginRouter);
  app.use('/api/query', queryRouter);

  return app;
}

export default createApp;
