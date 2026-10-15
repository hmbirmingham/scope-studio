// The address a request came from, for the dev-login audit. On Railway every
// request arrives through its proxy, which appends the real client address
// to X-Forwarded-For; the last entry is the one the proxy wrote, while
// earlier ones are whatever the client chose to send. Elsewhere the socket
// address is the truth and the header is not trusted at all.
export function clientIp(req, { behindProxy = process.env.NODE_ENV === 'production' } = {}) {
  if (behindProxy) {
    const hops = (req.get('x-forwarded-for') || '')
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress ?? null;
}
