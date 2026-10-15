// Every error the API sends has the same shape: a sentence a person can read,
// and a code the engine can branch on. Upstream or driver text never goes in.
export function sendError(res, status, code, error) {
  return res.status(status).json({ error, code });
}
