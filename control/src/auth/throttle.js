// Failed sign-ins per email inside a sliding window. It lives in memory: the
// control plane runs as one Railway instance, and losing the counts on a
// redeploy costs an attacker's guessing budget nothing worth a table. If the
// service ever scales out, this is the one piece to move into Postgres.
export function createLoginThrottle({ limit = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const failures = new Map();

  function recent(key) {
    const cutoff = now() - windowMs;
    const kept = (failures.get(key) || []).filter((at) => at > cutoff);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  }

  // A full sweep once the map grows, so a spray of distinct emails cannot
  // hold memory forever.
  function sweep() {
    if (failures.size < 10_000) return;
    for (const key of [...failures.keys()]) recent(key);
  }

  return {
    isBlocked(key) {
      return recent(key).length >= limit;
    },
    recordFailure(key) {
      sweep();
      const kept = recent(key);
      kept.push(now());
      failures.set(key, kept);
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
