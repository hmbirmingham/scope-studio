// Engine shutdown for the runner. Stopping the worker waits for each run in
// flight to reach a step boundary, and a step can be a long test suite or a
// slow model call, so waiting for it unconditionally could hold the process
// open far longer than whatever is stopping it allows. After `timeoutMs` the
// engine exits anyway: the runs still in flight keep their leases, which
// expire, and any worker resumes them from their last checkpoint, exactly as
// after a crash. Nothing is lost that a crash would not also lose.

export const SHUTDOWN_TIMEOUT_MS = 10_000;

// Calls stop() on each of `parts` (the worker, the scheduler) and resolves
// with 'stopped' once all have settled, or 'timed_out' after `timeoutMs`,
// whichever comes first. A part whose stop() throws counts as stopped.
export async function stopWithin(parts, { timeoutMs = SHUTDOWN_TIMEOUT_MS } = {}) {
  const stopping = Promise.allSettled(parts.map((part) => Promise.resolve().then(() => part.stop()))).then(() => 'stopped');
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs);
  });
  try {
    return await Promise.race([stopping, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
