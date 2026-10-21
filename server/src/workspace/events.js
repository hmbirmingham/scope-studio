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
// holding a long run's whole output in memory. The buffer is shared by every
// run, so it is bounded however many runs the engine has seen.
const REPLAY_EVENTS = 5000;

// `seq` is one counter for the whole engine, so a single Last-Event-ID resumes
// a stream of every run as well as a stream of one. The event id also carries
// the boot it was issued in: after a restart the counter starts again, and an
// id from the previous boot means "replay what you have", never "skip the
// first N events".
export function createEventBus({ now = () => new Date(), boot = Math.floor(Date.now() / 1000).toString(36), replay = REPLAY_EVENTS } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const history = [];
  let seq = 0;

  function publish({ runId, agentId, ownerId, type, data = {} }) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type ${type}`);
    seq += 1;
    const event = { v: 1, id: `${boot}-${seq}`, seq, runId, agentId, at: now().toISOString(), type, data };
    history.push({ ownerId, event });
    if (history.length > replay) history.shift();
    emitter.emit('event', { ownerId, event });
    return event;
  }

  function afterSeqFor(lastEventId) {
    const match = /^([a-z0-9]+)-(\d+)$/.exec(lastEventId ?? '');
    return match && match[1] === boot ? Number(match[2]) : 0;
  }

  // Delivers only the owner's events, optionally for one run, replaying what
  // came after `lastEventId` first. A listener that throws is cut off rather
  // than allowed to fail the publisher, so a broken connection can never stop
  // a run. Returns the unsubscribe function.
  function subscribe({ ownerId, runId = null, lastEventId = null }, listener) {
    const afterSeq = afterSeqFor(lastEventId);
    const wanted = (entry) => entry.ownerId === ownerId && (!runId || entry.event.runId === runId);
    let handler = null;
    const unsubscribe = () => {
      if (handler) emitter.off('event', handler);
      handler = null;
    };
    const deliver = (event) => {
      try {
        listener(event);
      } catch {
        unsubscribe();
      }
    };
    handler = (entry) => {
      if (wanted(entry)) deliver(entry.event);
    };
    for (const entry of history) {
      if (!handler) break;
      if (wanted(entry) && entry.event.seq > afterSeq) deliver(entry.event);
    }
    if (handler) emitter.on('event', handler);
    return unsubscribe;
  }

  return { publish, subscribe };
}

export function formatSse(event) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// The engine's single bus. Tests create their own with createEventBus.
export const workspaceEvents = createEventBus();
