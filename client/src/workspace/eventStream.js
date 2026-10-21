// One Server-Sent Events connection to /api/workspace/events, shared by every
// part of the workspace that wants live activity (the run view, the approvals
// badge, the agent cursor on the map). See "Activity event stream" in
// docs/architecture/agent-workspace.md.
//
// Reconnecting is the browser's job: EventSource retries by itself and sends
// Last-Event-ID, so the engine replays what was missed from its buffer. What
// this module adds is (1) a resync signal after any reconnect, because the
// replay buffer is bounded and the HTTP records are the durable truth, (2)
// reopening when the browser gives up for good (a non-200 answer closes an
// EventSource permanently; a new EventSource cannot send Last-Event-ID, so
// the resync over HTTP is what catches it up), and (3) dropping an event already delivered, since
// a replay may overlap what arrived just before the connection broke.

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

const CONNECTING = 0;
const CLOSED = 2;
const MAX_REOPEN_MS = 30_000;

// `<boot>-<seq>`: seq orders events within one engine process; a new boot
// means the engine restarted and its counter began again.
export function parseEventId(id) {
  if (typeof id !== 'string') return null;
  const cut = id.lastIndexOf('-');
  if (cut <= 0) return null;
  const seq = Number(id.slice(cut + 1));
  if (!Number.isInteger(seq)) return null;
  return { boot: id.slice(0, cut), seq };
}

export class WorkspaceEventStream {
  constructor({
    url = '/api/workspace/events',
    createSource = (target) => new EventSource(target, { withCredentials: true }),
    reopenDelayMs = 3_000,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    this.url = url;
    this.createSource = createSource;
    this.reopenDelayMs = reopenDelayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.listeners = new Set();
    this.resyncListeners = new Set();
    this.statusListeners = new Set();
    this.source = null;
    this.reopenTimer = null;
    this.reopenAttempts = 0;
    this.everOpened = false;
    this.interrupted = false;
    this.last = null;
    this.status = 'idle';
  }

  subscribe(listener) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.open();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  onResync(listener) {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  open() {
    if (this.source || typeof this.createSource !== 'function') return;
    let source;
    try {
      source = this.createSource(this.url);
    } catch {
      // No EventSource in this environment; the HTTP records still work.
      this.setStatus('unavailable');
      return;
    }
    this.source = source;
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting');

    const deliver = (message) => this.deliver(message);
    for (const type of EVENT_TYPES) source.addEventListener(type, deliver);
    source.addEventListener('message', deliver);
    source.addEventListener('open', () => {
      const resumed = this.everOpened && this.interrupted;
      this.everOpened = true;
      this.interrupted = false;
      this.reopenAttempts = 0;
      this.setStatus('open');
      if (resumed) for (const listener of this.resyncListeners) listener();
    });
    source.addEventListener('error', () => {
      if (source !== this.source) return;
      this.interrupted = true;
      if (source.readyState === CONNECTING) {
        // The browser is already retrying with Last-Event-ID.
        this.setStatus('reconnecting');
        return;
      }
      if (source.readyState === CLOSED) this.scheduleReopen();
    });
  }

  scheduleReopen() {
    this.source?.close();
    this.source = null;
    if (this.listeners.size === 0) return;
    this.setStatus('reconnecting');
    const delay = Math.min(this.reopenDelayMs * 2 ** this.reopenAttempts, MAX_REOPEN_MS);
    this.reopenAttempts += 1;
    this.reopenTimer = this.setTimer(() => {
      this.reopenTimer = null;
      this.open();
    }, delay);
  }

  close() {
    if (this.reopenTimer !== null) this.clearTimer(this.reopenTimer);
    this.reopenTimer = null;
    this.source?.close();
    this.source = null;
    this.setStatus('idle');
  }

  deliver(message) {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!event || typeof event.type !== 'string') return;
    const position = parseEventId(event.id ?? message.lastEventId);
    if (position) {
      if (this.last && this.last.boot === position.boot && position.seq <= this.last.seq) return;
      this.last = position;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One broken view must not starve the others of events.
        console.error('workspace event listener failed', error);
      }
    }
  }
}
