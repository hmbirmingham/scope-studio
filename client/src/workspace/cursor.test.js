import { describe, expect, it } from 'vitest';
import { AgentCursor, CURSOR_TIMING, NEUTRAL_AGENT_COLOR, markIntensity, mixColor, safeColor } from './cursor.js';

describe('markIntensity', () => {
  it('holds at the peak, fades, then reaches exactly zero', () => {
    const { peak, holdMs, fadeMs } = CURSOR_TIMING.written;
    const mark = { kind: 'written', at: 1000 };
    expect(markIntensity(mark, 1000)).toBe(peak);
    expect(markIntensity(mark, 1000 + holdMs)).toBe(peak);
    const mid = markIntensity(mark, 1000 + holdMs + fadeMs / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(peak);
    expect(markIntensity(mark, 1000 + holdMs + fadeMs)).toBe(0);
  });

  it('makes a touch quieter and shorter than a write', () => {
    expect(CURSOR_TIMING.touched.peak).toBeLessThan(CURSOR_TIMING.written.peak);
    expect(CURSOR_TIMING.touched.holdMs + CURSOR_TIMING.touched.fadeMs).toBeLessThan(CURSOR_TIMING.written.holdMs + CURSOR_TIMING.written.fadeMs);
  });
});

describe('mixColor', () => {
  it('runs from the resting colour to the agent colour', () => {
    expect(mixColor('#2e2e38', '#e5484d', 0)).toBe('#2e2e38');
    expect(mixColor('#2e2e38', '#e5484d', 1)).toBe('#e5484d');
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixColor('#000000', '#ffffff', 7)).toBe('#ffffff');
  });
});

describe('safeColor', () => {
  it('only lets #rrggbb through', () => {
    expect(safeColor('#E5484D')).toBe('#e5484d');
    expect(safeColor('red')).toBe(NEUTRAL_AGENT_COLOR);
    expect(safeColor('url(javascript:1)')).toBe(NEUTRAL_AGENT_COLOR);
    expect(safeColor(null)).toBe(NEUTRAL_AGENT_COLOR);
  });
});

describe('AgentCursor', () => {
  it('lights marked nodes in the agent colour and leaves the rest at rest', () => {
    const cursor = new AgentCursor();
    cursor.mark(['a', 'b'], '#3e63dd', 'touched', 0);
    expect(cursor.sample('a', 0)).toEqual({ color: '#3e63dd', intensity: CURSOR_TIMING.touched.peak });
    expect(cursor.sample('c', 0)).toBeNull();
  });

  it('fades back to rest and prunes faded marks', () => {
    const cursor = new AgentCursor();
    cursor.mark(['a'], '#3e63dd', 'touched', 0);
    const gone = CURSOR_TIMING.touched.holdMs + CURSOR_TIMING.touched.fadeMs;
    expect(cursor.sample('a', gone)).toBeNull();
    cursor.prune(gone);
    expect(cursor.size).toBe(0);
  });

  it('never lets a glance dim a node still glowing from a write', () => {
    const cursor = new AgentCursor();
    cursor.mark(['a'], '#e5484d', 'written', 0);
    cursor.mark(['a'], '#3e63dd', 'touched', 100);
    expect(cursor.sample('a', 100)).toEqual({ color: '#e5484d', intensity: 1 });
    // Once the write has faded below a touch's peak, a new touch takes over.
    const later = CURSOR_TIMING.written.holdMs + CURSOR_TIMING.written.fadeMs * 0.9;
    cursor.mark(['a'], '#3e63dd', 'touched', later);
    expect(cursor.sample('a', later).color).toBe('#3e63dd');
  });

  it('lets a write from another agent take the node', () => {
    const cursor = new AgentCursor();
    cursor.mark(['a'], '#e5484d', 'written', 0);
    cursor.mark(['a'], '#30a46c', 'written', 10);
    expect(cursor.sample('a', 10).color).toBe('#30a46c');
  });

  it('sanitises colours and skips bad ids', () => {
    const cursor = new AgentCursor();
    cursor.mark(['a', '', null], 'not-a-colour', 'whatever', 0);
    expect(cursor.size).toBe(1);
    expect(cursor.sample('a', 0)).toEqual({ color: NEUTRAL_AGENT_COLOR, intensity: CURSOR_TIMING.touched.peak });
  });
});
