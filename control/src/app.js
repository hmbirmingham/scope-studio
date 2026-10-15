import express from 'express';
import { getPool } from './db/pool.js';
import accountsRouter from './routes/accounts.js';
import billingRouter, { billingWebhook } from './routes/billing.js';
import cloudRouter from './routes/cloud.js';

function createApp(env, { pool = getPool() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.post('/v1/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), billingWebhook);
  app.use(express.json());

  // Railway holds a deploy back until this answers 200, so it checks the
  // database too: a control plane that cannot reach its ledger must not take
  // traffic, or it could serve platform-paid answers it cannot meter.
  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', env: env.nodeEnv });
    } catch {
      res.status(503).json({ status: 'unavailable', error: 'database unreachable' });
    }
  });

  // Each router declares its own full paths, so a new page or endpoint never
  // needs an edit here.
  app.use(accountsRouter);
  app.use(billingRouter);
  app.use(cloudRouter);

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  return app;
}

export default createApp;
