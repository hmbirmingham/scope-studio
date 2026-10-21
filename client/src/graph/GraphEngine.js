import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import { AgentCursor, mixColor } from '../workspace/cursor.js';

const MIN_RADIUS = 3;
const MAX_RADIUS = 22;
const RADIUS_SCALE = 0.55;

const CAMERA_LERP = 0.08;
const MIN_SCALE = 0.15;
const MAX_SCALE = 4;

const REST_CORE = '#2E2E38';
const REST_EDGE = '#15151A';
const REST_RIM = 'rgba(255,255,255,0.10)';
const ACTIVE = '#4FACFE';
const SELECTED = '#00F2FE';
const TRAVERSED = '#6E40C9';

export function nodeRadius(tokenLength) {
  const raw = 2 + Math.sqrt(Math.max(tokenLength ?? 0, 1)) * RADIUS_SCALE;
  return Math.min(Math.max(raw, MIN_RADIUS), MAX_RADIUS);
}

export function edgeKey(source, target) {
  return `${source}->${target}`;
}

export class GraphEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.nodesById = new Map();
    this.edges = [];

    this.active = new Set();
    this.traversed = new Set();
    this.preferences = new Map();
    this.selectedId = null;
    this.hoveredId = null;
    // Nodes an agent is touching or just wrote; sampled per frame, fed by
    // markAgentNodes from the activity stream, never by React state.
    this.agentCursor = new AgentCursor();
    this.frameTime = 0;

    this.camera = { x: 0, y: 0, scale: 1, targetX: 0, targetY: 0, targetScale: 1 };
    this.autoFit = true;
    this.phase = 0;
    this.rafId = null;
    this.disposed = false;
    this.dragging = null;

    this.onHoverChange = null;
    this.onSelect = null;
    this.onCameraChange = null;

    this.handleResize = () => this.resize();
    this.handlePointerMove = (event) => this.pointerMove(event);
    this.handlePointerDown = (event) => this.pointerDown(event);
    this.handlePointerUp = () => this.pointerUp();
    this.handleWheel = (event) => this.wheel(event);

    window.addEventListener('resize', this.handleResize);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });

    // Built stopped: ticking happens inside our own rAF loop so physics shares
    // the frame budget with drawing instead of running on d3's separate timer.
    // forceX/forceY are the containment: project clusters share no edges, so
    // with charge alone they repel each other off-screen forever.
    this.simulation = forceSimulation([])
      .force('charge', forceManyBody().strength(-140).distanceMax(400))
      .force('link', forceLink([]).id((node) => node.id).distance(55).strength(0.35))
      .force('center', forceCenter(0, 0))
      .force('containX', forceX(0).strength(0.02))
      .force('containY', forceY(0).strength(0.02))
      .stop();

    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
  }

  start() {
    const loop = () => {
      if (this.disposed) return;
      this.tickPhysics();
      // Track the graph while it organises, then leave the camera alone.
      if (this.autoFit && this.simulation.alpha() > this.simulation.alphaMin()) this.fitView();
      this.lerpCamera();
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  dispose() {
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.simulation.stop();
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('wheel', this.handleWheel);
  }

  tickPhysics() {
    this.phase += 0.02;
    const alpha = this.simulation.alpha();
    if (alpha <= this.simulation.alphaMin()) return;
    const ticks = alpha > 0.3 ? 5 : 1;
    for (let i = 0; i < ticks; i++) this.simulation.tick();
  }

  lerpCamera() {
    const cam = this.camera;
    cam.x += (cam.targetX - cam.x) * CAMERA_LERP;
    cam.y += (cam.targetY - cam.y) * CAMERA_LERP;
    const before = cam.scale;
    cam.scale += (cam.targetScale - cam.scale) * CAMERA_LERP;
    if (this.onCameraChange && Math.abs(cam.scale - before) > 0.001) {
      this.onCameraChange(cam.scale);
    }
  }

  worldToScreen(x, y) {
    const cam = this.camera;
    return {
      x: (x - cam.x) * cam.scale + this.width / 2,
      y: (y - cam.y) * cam.scale + this.height / 2,
    };
  }

  screenToWorld(x, y) {
    const cam = this.camera;
    return {
      x: (x - this.width / 2) / cam.scale + cam.x,
      y: (y - this.height / 2) / cam.scale + cam.y,
    };
  }

  focusOn(x, y, scale) {
    this.autoFit = false;
    this.camera.targetX = x;
    this.camera.targetY = y;
    if (scale) this.camera.targetScale = Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
  }

  bounds() {
    const nodes = [...this.nodesById.values()];
    if (nodes.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of nodes) {
      const radius = nodeRadius(node.tokenLength);
      minX = Math.min(minX, node.x - radius);
      maxX = Math.max(maxX, node.x + radius);
      minY = Math.min(minY, node.y - radius);
      maxY = Math.max(maxY, node.y + radius);
    }
    return { minX, maxX, minY, maxY };
  }

  // Sets camera targets only — the existing lerp does the smoothing.
  fitView(padding = 60) {
    const box = this.bounds();
    if (!box) return;
    const width = Math.max(box.maxX - box.minX, 1);
    const height = Math.max(box.maxY - box.minY, 1);
    const scale = Math.min(
      (this.width - padding * 2) / width,
      (this.height - padding * 2) / height
    );
    this.camera.targetX = (box.minX + box.maxX) / 2;
    this.camera.targetY = (box.minY + box.maxY) / 2;
    this.camera.targetScale = Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
  }

  // Clusters are emergent from the simulation, so "go to this project" means
  // flying to the live centroid of its nodes rather than a fixed coordinate.
  focusOnProject(project) {
    const members = [...this.nodesById.values()].filter((node) => node.project === project);
    if (members.length === 0) return;
    const x = members.reduce((sum, node) => sum + node.x, 0) / members.length;
    const y = members.reduce((sum, node) => sum + node.y, 0) / members.length;
    const spread = Math.max(
      ...members.map((node) => Math.hypot(node.x - x, node.y - y)),
      80
    );
    this.focusOn(x, y, Math.min(this.height, this.width) / (spread * 2.4));
  }

  focusOnNode(id) {
    const node = this.nodesById.get(id);
    if (node) this.focusOn(node.x, node.y);
  }

  // Diffed, not replaced: unchanged nodes keep their simulated position so a
  // refetch doesn't scatter the layout the user is already looking at.
  syncNodes(nodes, edges) {
    const incoming = new Set(nodes.map((node) => node.id));
    for (const id of [...this.nodesById.keys()]) {
      if (!incoming.has(id)) this.nodesById.delete(id);
    }

    let added = false;
    for (const node of nodes) {
      const existing = this.nodesById.get(node.id);
      if (existing) {
        Object.assign(existing, node, { x: existing.x, y: existing.y, vx: existing.vx, vy: existing.vy });
      } else {
        const angle = Math.random() * Math.PI * 2;
        const spread = 120 + Math.random() * 260;
        this.nodesById.set(node.id, {
          ...node,
          x: node.x ?? Math.cos(angle) * spread,
          y: node.y ?? Math.sin(angle) * spread,
          vx: 0,
          vy: 0,
        });
        added = true;
      }
    }

    this.edges = edges.filter(
      (edge) => this.nodesById.has(edge.source) && this.nodesById.has(edge.target)
    );
    this.simulation.nodes([...this.nodesById.values()]);
    this.simulation
      .force('link')
      .links(this.edges.map((edge) => ({ source: edge.source, target: edge.target })));
    if (added) {
      this.simulation.alpha(0.5);
      this.autoFit = true;
    }
  }

  setActive(ids) {
    this.active = new Set(ids);
  }

  setTraversed(keys) {
    this.traversed = new Set(keys);
  }

  setSelected(id) {
    this.selectedId = id;
  }

  markAgentNodes(ids, color, kind = 'touched') {
    this.agentCursor.mark(ids, color, kind, performance.now());
  }

  setPreference(id, preference) {
    if (preference) this.preferences.set(id, preference);
    else this.preferences.delete(id);
  }

  hitTest(screenX, screenY) {
    let found = null;
    for (const node of this.nodesById.values()) {
      const point = this.worldToScreen(node.x, node.y);
      const radius = nodeRadius(node.tokenLength) * this.camera.scale;
      if (Math.hypot(screenX - point.x, screenY - point.y) <= radius + 6) found = node;
    }
    return found;
  }

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  pointerMove(event) {
    const point = this.localPoint(event);

    if (this.dragging) {
      this.autoFit = false;
      const dx = (point.x - this.dragging.x) / this.camera.scale;
      const dy = (point.y - this.dragging.y) / this.camera.scale;
      this.camera.targetX -= dx;
      this.camera.targetY -= dy;
      this.camera.x -= dx;
      this.camera.y -= dy;
      this.dragging = point;
      return;
    }

    const hit = this.hitTest(point.x, point.y);
    const id = hit ? hit.id : null;
    this.canvas.style.cursor = hit ? 'pointer' : 'default';
    // React only hears about hover when the target actually changes, never per frame.
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      if (this.onHoverChange) {
        this.onHoverChange(hit ? { node: hit, screen: this.worldToScreen(hit.x, hit.y) } : null);
      }
    }
  }

  pointerDown(event) {
    const point = this.localPoint(event);
    const hit = this.hitTest(point.x, point.y);
    if (hit) {
      this.selectedId = hit.id;
      if (this.onSelect) this.onSelect(hit);
      return;
    }
    this.dragging = point;
  }

  pointerUp() {
    this.dragging = null;
  }

  wheel(event) {
    event.preventDefault();
    this.autoFit = false;
    const point = this.localPoint(event);
    const before = this.screenToWorld(point.x, point.y);
    const factor = Math.exp(-event.deltaY * 0.0015);
    const scale = Math.min(Math.max(this.camera.targetScale * factor, MIN_SCALE), MAX_SCALE);
    this.camera.targetScale = scale;
    this.camera.scale = scale;
    const after = this.screenToWorld(point.x, point.y);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.camera.targetX = this.camera.x;
    this.camera.targetY = this.camera.y;
  }

  nodeState(node) {
    if (node.id === this.selectedId) return 'selected';
    if (this.active.has(node.id)) return 'active';
    if (this.agentCursor.sample(node.id, this.frameTime)) return 'agent';
    if (node.id === this.hoveredId) return 'hovered';
    return 'rest';
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    this.frameTime = performance.now();
    this.agentCursor.prune(this.frameTime);
    this.drawEdges(ctx);
    for (const node of this.nodesById.values()) this.drawNode(ctx, node);
  }

  drawEdges(ctx) {
    for (const edge of this.edges) {
      const source = this.nodesById.get(edge.source);
      const target = this.nodesById.get(edge.target);
      const a = this.worldToScreen(source.x, source.y);
      const b = this.worldToScreen(target.x, target.y);
      const lit = this.traversed.has(edgeKey(edge.source, edge.target));

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (lit) {
        const pulse = 0.4 + 0.35 * Math.sin(this.phase * 2);
        ctx.strokeStyle = `rgba(110,64,201,${pulse})`;
        ctx.lineWidth = 1.4;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 0.7;
      }
      ctx.stroke();
    }
  }

  drawNode(ctx, node) {
    const point = this.worldToScreen(node.x, node.y);
    const radius = nodeRadius(node.tokenLength) * this.camera.scale;
    if (point.x < -radius || point.x > this.width + radius) return;
    if (point.y < -radius || point.y > this.height + radius) return;

    const state = this.nodeState(node);
    // An agent's colour rises out of the resting obsidian and sinks back into
    // it as the mark fades, so a node at rest never carries a hue.
    const agent = state === 'agent' ? this.agentCursor.sample(node.id, this.frameTime) : null;
    const hue = state === 'selected' ? SELECTED : state === 'active' ? ACTIVE : agent ? mixColor(REST_CORE, agent.color, agent.intensity) : null;

    if (hue) {
      const pulse = state === 'active' ? 0.65 + 0.35 * Math.sin(this.phase * 1.6 + node.x) : agent ? agent.intensity : 1;
      ctx.save();
      ctx.shadowColor = hue;
      ctx.shadowBlur = radius * 2.6 * pulse;
    }

    // Off-centre highlight is what reads as a glass sphere rather than a flat dot.
    const gradient = ctx.createRadialGradient(
      point.x - radius * 0.3,
      point.y - radius * 0.35,
      radius * 0.1,
      point.x,
      point.y,
      radius
    );
    gradient.addColorStop(0, hue ?? REST_CORE);
    gradient.addColorStop(1, hue ? this.shade(hue) : REST_EDGE);

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    if (hue) ctx.restore();

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = state === 'hovered' ? 'rgba(255,255,255,0.35)' : REST_RIM;
    ctx.lineWidth = 1;
    ctx.stroke();

    const preference = this.preferences.get(node.id);
    if (preference) {
      ctx.font = `${Math.max(9, 8 * this.camera.scale)}px 'Space Mono', monospace`;
      ctx.fillStyle = PREFERENCE_COLORS[preference] ?? '#8A8A96';
      ctx.textAlign = 'left';
      ctx.fillText(PREFERENCE_GLYPHS[preference] ?? '', point.x + radius + 3, point.y - radius + 2);
    }

    // Labels only where attention already is — the map stays uncluttered at rest.
    if (state !== 'rest' && (!agent || agent.intensity > 0.4) && node.label) {
      ctx.font = `500 ${Math.min(12, 11 * Math.max(this.camera.scale, 0.8))}px 'Space Grotesk', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(240,240,242,0.92)';
      ctx.fillText(node.label, point.x, point.y + radius + 13);
    }
  }

  shade(hex) {
    const value = parseInt(hex.slice(1), 16);
    const r = Math.round(((value >> 16) & 255) * 0.35);
    const g = Math.round(((value >> 8) & 255) * 0.35);
    const b = Math.round((value & 255) * 0.35);
    return `rgb(${r},${g},${b})`;
  }
}

export const PREFERENCE_COLORS = {
  pin: '#F59E0B',
  boost: '#22C55E',
  suppress: '#F87171',
  local: '#A855F7',
};

export const PREFERENCE_GLYPHS = {
  pin: '★',
  boost: '↑',
  suppress: '↓',
  local: '■',
};

export const ACTIVATION_COLORS = { ACTIVE, SELECTED, TRAVERSED };
