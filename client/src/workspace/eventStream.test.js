import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENT_TYPES, WorkspaceEventStream, parseEventId } from './eventStream.js';
import { FakeEventSource, workspaceEvent } from '../test/fakeEventSource.js';

function makeStream() {
  const timers = [];
  const stream = new WorkspaceEventStream({
    createSource: (url) => new FakeEventSource(url),
    reopenDelayMs: 100,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  return { stream, timers };
}

afterEach(() => FakeEventSource.reset());

describe('parseEventId', () => {
  it('splits boot and seq', () => {
    expect(parseEventId('k3x9-42')).toEqual({ boot: 'k3x9', seq: 42 });
    expect(parseEventId('nope')).toBeNull();
    expect(parseEventId(undefined)).toBeNull();
  });
});

describe('WorkspaceEventStream', () => {
  it('connects on the first subscriber and closes after the last', () => {
    const { stream } = makeStream();
    const stopA = stream.subscribe(() => {});
    const stopB = stream.subscribe(() => {});
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toBe('/api/workspace/events');
    stopA();
    expect(FakeEventSource.latest().closed).toBe(false);
    stopB();
    expect(FakeEventSource.latest().closed).toBe(true);
    expect(stream.status).toBe('idle');
  });

  it('listens for every named event type in the contract', () => {
    const { stream } = makeStream();
    const seen = [];
    stream.subscribe((event) => seen.push(event.type));
    const source = FakeEventSource.latest();
    source.open();
    for (const type of EVENT_TYPES) source.emit(workspaceEvent(type));
    expect(seen).toEqual(EVENT_TYPES);
  });

  it('drops an event it already delivered when a replay overlaps', () => {
    const { stream } = makeStream();
    const seen = [];
    stream.subscribe((event) => seen.push(event.id));
    const source = FakeEventSource.latest();
    source.open();
    source.emit(workspaceEvent('step.output', { id: 'b1-1' }));
    source.emit(workspaceEvent('step.output', { id: 'b1-2' }));
    source.emit(workspaceEvent('step.output', { id: 'b1-2' }));
    source.emit(workspaceEvent('step.output', { id: 'b1-1' }));
    source.emit(workspaceEvent('step.output', { id: 'b1-3' }));
    expect(seen).toEqual(['b1-1', 'b1-2', 'b1-3']);
  });

  it('accepts a lower seq from a new engine boot', () => {
    const { stream } = makeStream();
    const seen = [];
    stream.subscribe((event) => seen.push(event.id));
    const source = FakeEventSource.latest();
    source.open();
    source.emit(workspaceEvent('run.started', { id: 'b1-50' }));
    source.emit(workspaceEvent('run.started', { id: 'b2-1' }));
    expect(seen).toEqual(['b1-50', 'b2-1']);
  });

  it('signals a resync after the browser reconnects by itself, not on the first open', () => {
    const { stream } = makeStream();
    const resync = vi.fn();
    stream.onResync(resync);
    const statuses = [];
    stream.onStatus((status) => statuses.push(status));
    stream.subscribe(() => {});
    const source = FakeEventSource.latest();
    source.open();
    expect(resync).not.toHaveBeenCalled();
    source.drop();
    expect(stream.status).toBe('reconnecting');
    // The browser reconnects on the same EventSource, sending Last-Event-ID.
    source.open();
    expect(resync).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
  });

  it('reopens with backoff when the browser gives up, then resyncs', () => {
    const { stream, timers } = makeStream();
    const resync = vi.fn();
    stream.onResync(resync);
    stream.subscribe(() => {});
    FakeEventSource.latest().open();
    FakeEventSource.latest().refuse();
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(timers.map((timer) => timer.ms)).toEqual([100]);
    timers[0].fn();
    expect(FakeEventSource.instances).toHaveLength(2);
    // Refused again before opening: the wait doubles.
    FakeEventSource.latest().refuse();
    expect(timers.map((timer) => timer.ms)).toEqual([100, 200]);
    timers[1].fn();
    FakeEventSource.latest().open();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('does not reopen once nobody is listening', () => {
    const { stream, timers } = makeStream();
    const stop = stream.subscribe(() => {});
    stop();
    FakeEventSource.latest().refuse();
    expect(timers).toHaveLength(0);
  });

  it('keeps delivering to other listeners when one throws', () => {
    const { stream } = makeStream();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];
    stream.subscribe(() => {
      throw new Error('broken view');
    });
    stream.subscribe((event) => seen.push(event.type));
    FakeEventSource.latest().emit(workspaceEvent('cost'));
    expect(seen).toEqual(['cost']);
    expect(error).toHaveBeenCalled();
  });

  it('ignores malformed data', () => {
    const { stream } = makeStream();
    const seen = [];
    stream.subscribe((event) => seen.push(event));
    FakeEventSource.latest().dispatch('cost', { data: 'not json' });
    FakeEventSource.latest().dispatch('message', { data: '{"no":"type"}' });
    expect(seen).toEqual([]);
  });

  it('reports unavailable when EventSource cannot be built', () => {
    const stream = new WorkspaceEventStream({
      createSource: () => {
        throw new Error('no EventSource');
      },
    });
    stream.subscribe(() => {});
    expect(stream.status).toBe('unavailable');
  });
});
