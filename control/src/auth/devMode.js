import { devModeEmails } from '../config/env.js';

// What a dev-mode device gets instead of its account's billed plan: the top
// plan, so every gated path can be exercised without a subscription.
export const DEV_MODE_PLAN = 'engineer';

export function isDevModeEmail(email, env = process.env) {
  return typeof email === 'string' && devModeEmails(env).has(email.trim().toLowerCase());
}

// The plan a request runs under. A device's dev mode counts only while its
// email is still on the allowlist, so the flag stored on an old token is never
// enough by itself. accounts.plan is returned untouched otherwise: billing
// owns that column and dev mode never writes it.
export function effectivePlan({ plan, email, devMode }, env = process.env) {
  const active = devMode === true && isDevModeEmail(email, env);
  return { plan: active ? DEV_MODE_PLAN : plan, devMode: active };
}
