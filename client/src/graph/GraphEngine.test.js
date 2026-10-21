import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphEngine } from './GraphEngine.js';
import { CURSOR_TIMING } from '../workspace/cursor.js';

// A 2D context that records the colours each node's gradient was filled with.
function fakeCanvas() {
  const stops = [];
  const ctx = new Proxy(
    {
      createRadialGradient: () => ({ addColorStop: (offset, color) => stops.push({ offset, color }) }),
    },
    { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true }
  );
  const canvas = {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
    width: 0,
    height: 0,
  };
  return { canvas, stops };
}

function engineWithNode() {
  const { canvas, stops } = fakeCanvas();
  const engine = new GraphEngine(canvas);
  engine.syncNodes([{ id: 'n1', label: 'Node', tokenLength: 100, x: 0, y: 0 }], []);
  const coreColor = () => {
    stops.length = 0;
    engine.draw();
    return stops.find((stop) => stop.offset === 0)?.color;
  };
  return { engine, coreColor };
}

let engines = [];
afterEach(() => {
  for (const engine of engines) engine.dispose();
  engines = [];
});

describe('GraphEngine agent cursor', () => {
  it('draws a node in obsidian at rest and in the agent colour when written', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { engine, coreColor } = engineWithNode();
    engines.push(engine);
    expect(coreColor()).toBe('#2E2E38');
    engine.markAgentNodes(['n1'], '#e5484d', 'written');
    expect(engine.nodeState(engine.nodesById.get('n1'))).toBe('agent');
    expect(coreColor()).toBe('#e5484d');
    // Faded completely: no hue again, and the mark is gone.
    now.mockReturnValue(1000 + CURSOR_TIMING.written.holdMs + CURSOR_TIMING.written.fadeMs + 1);
    expect(coreColor()).toBe('#2E2E38');
    expect(engine.agentCursor.size).toBe(0);
  });

  it('blends toward rest while fading', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { engine, coreColor } = engineWithNode();
    engines.push(engine);
    engine.markAgentNodes(['n1'], '#ffffff', 'touched');
    now.mockReturnValue(CURSOR_TIMING.touched.holdMs + CURSOR_TIMING.touched.fadeMs / 2);
    const color = coreColor();
    expect(color).not.toBe('#ffffff');
    expect(color).not.toBe('#2E2E38');
  });

  it('keeps selection and retrieval highlights above the agent colour', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { engine } = engineWithNode();
    engines.push(engine);
    engine.markAgentNodes(['n1'], '#e5484d', 'written');
    engine.setActive(['n1']);
    expect(engine.nodeState(engine.nodesById.get('n1'))).toBe('active');
    engine.setSelected('n1');
    expect(engine.nodeState(engine.nodesById.get('n1'))).toBe('selected');
  });
});
