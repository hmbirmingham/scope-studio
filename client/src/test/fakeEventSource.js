// A stand-in for the browser's EventSource that a test drives by hand: open
// it, push named events, or fail it the way a dropped connection (CONNECTING,
// the browser will retry) or a refused one (CLOSED, it will not) does.
export class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, message = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(message);
  }

  open() {
    this.readyState = 1;
    this.dispatch('open');
  }

  // `event` is the contract's envelope; its id doubles as the SSE id.
  emit(event) {
    this.dispatch(event.type, { data: JSON.stringify(event), lastEventId: event.id });
  }

  drop() {
    this.readyState = 0;
    this.dispatch('error');
  }

  refuse() {
    this.readyState = 2;
    this.dispatch('error');
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  static latest() {
    return FakeEventSource.instances.at(-1);
  }

  static reset() {
    FakeEventSource.instances = [];
  }
}

let seq = 0;
// Builds an event in the contract's envelope with a fresh id.
export function workspaceEvent(type, { runId = 'run-1', agentId = 'agent-1', data = {}, boot = 'b1', id } = {}) {
  seq += 1;
  const eventId = id ?? `${boot}-${seq}`;
  return { v: 1, id: eventId, seq: Number(eventId.split('-').pop()), runId, agentId, at: new Date(0).toISOString(), type, data };
}
