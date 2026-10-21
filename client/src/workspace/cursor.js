// The agent cursor on the map: which nodes an agent is touching or has just
// written, and how strongly each should glow in the agent's colour right now.
// The map's visual language is obsidian circles with no hue at rest, so a
// mark starts at its peak, holds briefly, then fades back to nothing.
//
// Plain data and arithmetic only: GraphEngine samples it inside its animation
// frame, so nothing here may touch React or allocate per node per frame
// beyond the colour string it returns.

export const CURSOR_TIMING = {
  // A read is a glance; a write is something the user may want to find.
  touched: { peak: 0.7, holdMs: 900, fadeMs: 2200 },
  written: { peak: 1, holdMs: 2000, fadeMs: 3500 },
};

export const NEUTRAL_AGENT_COLOR = '#8a8a96';

export function safeColor(color) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : NEUTRAL_AGENT_COLOR;
}

// 0 … peak: full during the hold, then an ease-out fade to exactly 0.
export function markIntensity(mark, now) {
  if (!mark) return 0;
  const timing = CURSOR_TIMING[mark.kind] ?? CURSOR_TIMING.touched;
  const age = now - mark.at;
  if (age < 0) return timing.peak;
  if (age <= timing.holdMs) return timing.peak;
  const fading = (age - timing.holdMs) / timing.fadeMs;
  if (fading >= 1) return 0;
  const remaining = 1 - fading;
  return timing.peak * remaining * remaining;
}

function channels(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// Linear blend from `from` to `to`; t is clamped to 0…1.
export function mixColor(from, to, t) {
  const amount = Math.min(Math.max(t, 0), 1);
  const a = channels(safeColor(from));
  const b = channels(safeColor(to));
  const mixed = a.map((value, i) => Math.round(value + (b[i] - value) * amount));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export class AgentCursor {
  constructor() {
    this.marks = new Map();
  }

  // A fresh glance never dims a node that is still glowing from a write.
  mark(nodeIds, color, kind, now) {
    const timing = CURSOR_TIMING[kind] ?? CURSOR_TIMING.touched;
    const next = { color: safeColor(color), kind: CURSOR_TIMING[kind] ? kind : 'touched', at: now };
    for (const id of nodeIds ?? []) {
      if (typeof id !== 'string' || !id) continue;
      const existing = this.marks.get(id);
      if (existing && markIntensity(existing, now) > timing.peak) continue;
      this.marks.set(id, next);
    }
  }

  // `{ color, intensity }` for a lit node, or null at rest.
  sample(nodeId, now) {
    const mark = this.marks.get(nodeId);
    if (!mark) return null;
    const intensity = markIntensity(mark, now);
    if (intensity <= 0) return null;
    return { color: mark.color, intensity };
  }

  // Called once a frame; drops marks that have faded so the map stays cheap.
  prune(now) {
    for (const [id, mark] of this.marks) {
      if (markIntensity(mark, now) <= 0) this.marks.delete(id);
    }
  }

  get size() {
    return this.marks.size;
  }
}
