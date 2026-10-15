// The engine runs on the user's own machine and listens on a loopback port
// for the end of sign-in, so the only redirect a code may travel to is one
// that cannot leave that machine. Anything else would let a crafted link send
// a fresh code to a host someone else controls.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const MAX_LENGTH = 2048;

export function isLoopbackRedirect(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // The port is required: the engine picks a free one per sign-in, and a
  // default port would mean some other local service receives the code.
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.port !== '' &&
    url.port !== '0' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  );
}

// The redirect the browser follows: the engine's own URL with the code and
// state added, keeping any query it already carried.
export function redirectWithCode(redirectUri, { code, state }) {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}
