import { resendProviderFromEnv } from './resend.js';

// The notifier: one function per event the operator wants to hear about, all
// sent through a provider with a single `send({ to, subject, text })` method.
// A new event (a plug-in's security alert, a billing anomaly) is one more
// function here, and a new provider is one more file beside resend.js.

let providerOverride = null;

// Tests swap in a fake so nothing reaches the network; pass null to go back to
// the provider the environment configures.
export function setNotifyProvider(provider) {
  providerOverride = provider;
}

function resolveProvider(env) {
  return providerOverride ?? resendProviderFromEnv(env);
}

// A dev-mode sign-in grants the Engineer plan without a subscription, so the
// operator is told every time. With no provider or recipient configured the
// caller's audit row is still the record; this only logs one warning and
// skips, and never falls back to a default address.
export async function notifyDevLogin({ email, label, ip, at }, { env = process.env, log = console } = {}) {
  const to = env.DEV_LOGIN_NOTIFY_EMAIL;
  const provider = to ? resolveProvider(env) : null;
  if (!provider) {
    log.warn(
      'Dev-mode sign-in notification skipped: set RESEND_API_KEY, NOTIFY_FROM_EMAIL and DEV_LOGIN_NOTIFY_EMAIL to send it. The sign-in is still in dev_logins.'
    );
    return { sent: false };
  }

  const when = (at instanceof Date ? at : new Date(at)).toISOString();
  await provider.send({
    to,
    subject: `Scope Studio dev-mode sign-in: ${email}`,
    text: [
      `${email} signed in with dev mode (Engineer plan, unbilled).`,
      `Device: ${label || 'unnamed'}`,
      `IP: ${ip || 'unknown'}`,
      `At: ${when}`,
      '',
      'Remove the email from DEV_MODE_EMAILS to end dev mode on every device at once.',
    ].join('\n'),
  });
  return { sent: true };
}
