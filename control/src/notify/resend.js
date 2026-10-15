const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 5000;

// Email through Resend's HTTP API, over plain fetch so the control plane
// carries no provider SDK. Returns null unless both the key and the sender are
// configured: there is no default sender and no fallback key.
export function resendProviderFromEnv(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_FROM_EMAIL) return null;
  return createResendProvider({ apiKey: env.RESEND_API_KEY, from: env.NOTIFY_FROM_EMAIL, fetchImpl });
}

export function createResendProvider({ apiKey, from, fetchImpl = globalThis.fetch }) {
  return {
    name: 'resend',
    async send({ to, subject, text }) {
      const response = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Only the status is kept: the provider's response body could echo the
      // message, and none of it is needed to know the send failed.
      if (!response.ok) throw new Error(`Resend answered ${response.status}`);
    },
  };
}
