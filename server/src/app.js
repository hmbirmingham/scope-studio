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
import billingRouter, { billingWebhook } from './routes/billing.js';
import nodesRouter from './routes/nodes.js';
import githubPluginRouter from './routes/plugins/github.js';
import graphRouter from './routes/graph.js';
import queryRouter from './routes/query.js';
import usageRouter from './routes/usage.js';
import agentsRouter from './routes/workspace/agents.js';
import agentRunsRouter from './routes/workspace/agentRuns.js';
import approvalsRouter from './routes/workspace/approvals.js';
import tasksRouter from './routes/workspace/tasks.js';
import workspaceEventsRouter from './routes/workspace/events.js';

const PgSessionStore = connectPgSimple(session);

function createApp(env) {
  const app = express();

  // The billing webhook verifies a signature over the exact bytes it was sent,
  // so it reads the raw body and is mounted before the JSON parser.
  app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), billingWebhook);
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
  app.use('/api/billing', billingRouter);
  app.use('/api/graph', graphRouter);
  app.use('/api/nodes', nodesRouter);
  app.use('/api/plugins/github', githubPluginRouter);
  app.use('/api/query', queryRouter);
  app.use('/api/usage', usageRouter);
  // The agent workspace (docs/architecture/agent-workspace.md).
  app.use('/api/agents', agentsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/agent-runs', agentRunsRouter);
  app.use('/api/workspace/events', workspaceEventsRouter);

  return app;
}

export default createApp;
