import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getPool } from '../../db/pool.js';
import { workspaceEvents } from '../events.js';
import { localAdapter, platformAdapter } from '../modelPort.js';
import { executeRun } from './execute.js';
import { claimRun } from './store.js';

// The worker: claims runs from the durable queue and executes them. Each of
// `concurrency` loops runs one run at a time. Nothing about a run is held only
// in memory: if this process dies, its leases expire and any worker resumes
// the runs from their last checkpoint.

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_POLL_MS = 1_000;

// The adapters a background run can use. own_key is absent on purpose: the
// user's Key Pro key travels per request and is never stored, so a run that
// outlives the request has no key, and selectAdapter keeps it local.
export function defaultAdapters() {
  return { local: localAdapter(), platform: platformAdapter() };
}

export function createWorker({
  id = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
  concurrency = 1,
  pollMs = DEFAULT_POLL_MS,
  leaseMs = DEFAULT_LEASE_MS,
  heartbeatMs,
  adapters = defaultAdapters(),
  online = () => true,
  embed = true,
  gather,
  events = workspaceEvents,
  db = getPool(),
  onError = (err) => console.error(`agent worker: ${err.message}`),
} = {}) {
  let running = false;
  let stopping = false;
  let abandoned = false;
  const loops = [];
  const sleepers = new Set();

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sleepers.delete(wake);
        resolve();
      }, ms);
      timer.unref?.();
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      sleepers.add(wake);
    });
  }

  // Claims one run and executes it until it finishes, parks for approval or
  // stops. Returns the outcome, or null when the queue was empty.
  async function runNext() {
    if (abandoned) return null;
    const claimed = await claimRun({ workerId: id, leaseMs }, db);
    if (!claimed) return null;
    const outcome = await executeRun(claimed, {
      workerId: id,
      leaseMs,
      heartbeatMs: heartbeatMs ?? Math.max(50, Math.floor(leaseMs / 3)),
      adapters,
      // Read once per run and passed explicitly: can() fails closed without it.
      online: (await online()) === true,
      embed,
      gather,
      events,
      db,
      isAbandoned: () => abandoned,
      shouldRelease: () => stopping,
    });
    return { runId: claimed.id, outcome };
  }

  // Runs the queue until it is empty (tests use this to step deterministically).
  async function drain({ max = 100 } = {}) {
    const outcomes = [];
    for (let i = 0; i < max; i += 1) {
      const result = await runNext();
      if (!result) break;
      outcomes.push(result);
    }
    return outcomes;
  }

  async function loop() {
    while (running && !stopping && !abandoned) {
      let result = null;
      try {
        result = await runNext();
      } catch (err) {
        onError(err);
      }
      if (!result && running && !stopping) await sleep(pollMs);
    }
  }

  return {
    id,
    runNext,
    drain,
    start() {
      if (running) return;
      running = true;
      stopping = false;
      for (let i = 0; i < concurrency; i += 1) loops.push(loop());
    },
    // Wakes idle loops so a newly queued run starts without waiting a poll.
    poke() {
      for (const wake of [...sleepers]) wake();
    },
    // Stops claiming, hands any run in flight back to the queue at its next
    // step boundary, and resolves once every loop has exited.
    async stop() {
      stopping = true;
      for (const wake of [...sleepers]) wake();
      await Promise.allSettled(loops.splice(0));
      running = false;
      stopping = false;
    },
    // Simulates a crash: the worker stops writing anything, including lease
    // renewals, and leaves its runs exactly as they are. Tests only.
    abandon() {
      abandoned = true;
      running = false;
      for (const wake of [...sleepers]) wake();
    },
  };
}
