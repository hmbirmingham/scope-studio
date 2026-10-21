// The agent runner (path B): the durable queue, the worker that executes the
// run-step protocol, and the scheduler for recurring tasks.
export { createWorker, defaultAdapters, DEFAULT_LEASE_MS, DEFAULT_POLL_MS } from './worker.js';
export { createScheduler, enqueueDueTasks, DEFAULT_SCHEDULER_MS } from './scheduler.js';
export { executeRun, MAX_CONSECUTIVE_FAILURES } from './execute.js';
export { MAX_ATTEMPTS, TERMINAL_STATUSES, presentRun, presentStep } from './store.js';

// Lets the HTTP layer wake an idle worker when it queues a run, without the
// routes holding a reference to the worker (there is none in tests).
let wake = () => {};
export function setRunQueuedListener(listener) {
  wake = typeof listener === 'function' ? listener : () => {};
}
export function notifyRunQueued() {
  try {
    wake();
  } catch {
    // Waking is an optimisation; the worker polls anyway.
  }
}
