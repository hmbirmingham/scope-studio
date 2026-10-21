// The sign-in, checkout and portal links the plan overlay opens come from the
// server, which passes on what the control plane sent. Only a web page is
// opened: a javascript:, data: or file: link would run or read something in
// this app's context. Returns the normalised URL, or null.
export function webUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
