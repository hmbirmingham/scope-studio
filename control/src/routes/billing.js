import { Router } from 'express';
import { sendError } from '../lib/errors.js';

// Mounted at the root: routes here declare their full paths (see API.md).
const router = Router();

// Stripe signs the exact bytes it sends, so app.js mounts this before the JSON
// parser with a raw body.
export function billingWebhook(req, res) {
  sendError(res, 404, 'not_found', 'not found');
}

export default router;
