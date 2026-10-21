import { EventEmitter } from 'node:events';

// The activity event stream (docs/architecture/agent-workspace.md,
// "Activity event stream"). Events stay on this machine: they feed the UI's
// activity tabs and never go to the control plane.

export const EVENT_TYPES = [
  'run.queued',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.finished',
  'step.started',
  'step.output',
  'step.verified',
  'step.finished',
  'approval.requested',
  'approval.resolved',
  'node.written',
  'node.touched',
  'cost',
  'budget.exceeded',
];

// Enough for a client that briefly lost its connection to catch up, without
// holding a long run's whole output in memory.
const REPLAY_PER_RUN = 500;

export function createEventBus({ now = () => new Date() } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const sequences = new Map();
  const history = new Map();

  function publish({ runId, agentId, ownerId, type, data = {} }) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type ${type}`);
    const seq = (sequences.get(runId) ?? 0) + 1;
    sequences.set(runId, seq);
    const event = { v: 1, seq, runId, agentId, at: now().toISOString(), type, data };
    const kept = history.get(runId) ?? [];
    kept.push({ ownerId, event });
    if (kept.length > REPLAY_PER_RUN) kept.shift();
    history.set(runId, kept);
    emitter.emit('event', { ownerId, event });
    return event;
  }

  // Delivers only the owner's events, optionally for one run, replaying what
  // came after `afterSeq` first. Returns the unsubscribe function.
  function subscribe({ ownerId, runId = null, afterSeq = 0 }, listener) {
    if (runId) {
      for (const entry of history.get(runId) ?? []) {
        if (entry.ownerId === ownerId && entry.event.seq > afterSeq) listener(entry.event);
      }
    }
    const handler = (entry) => {
      if (entry.ownerId !== ownerId) return;
      if (runId && entry.event.runId !== runId) return;
      listener(entry.event);
    };
    emitter.on('event', handler);
    return () => emitter.off('event', handler);
  }

  function forget(runId) {
    history.delete(runId);
    sequences.delete(runId);
  }

  return { publish, subscribe, forget };
}

export function formatSse(event) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// The engine's single bus. Tests create their own with createEventBus.
export const workspaceEvents = createEventBus();
