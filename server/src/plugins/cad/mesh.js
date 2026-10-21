import { CadError } from './errors.js';
import { round } from './units.js';

// Geometry of a triangle mesh, in whatever unit its coordinates are in.
// Nothing here knows about files or units; callers say which unit applies.

// Vertices closer than this fraction of the bounding-box diagonal are the
// same vertex. Exporters write a shared vertex with identical numbers, so
// this only absorbs printing noise in ASCII files.
const WELD_FRACTION = 1e-9;

export function boundingBox(t) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (t[i + k] < min[k]) min[k] = t[i + k];
      if (t[i + k] > max[k]) max[k] = t[i + k];
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

function diagonal(box) {
  return Math.hypot(...box.size);
}

// Indexed vertices: welds equal positions so edges can be matched.
export function weld(t, box = boundingBox(t)) {
  const q = Math.max(diagonal(box) * WELD_FRACTION, 1e-12);
  const index = new Map();
  const faces = new Uint32Array(t.length / 3);
  let next = 0;
  for (let v = 0; v < t.length / 3; v += 1) {
    const key = `${Math.round(t[v * 3] / q)},${Math.round(t[v * 3 + 1] / q)},${Math.round(t[v * 3 + 2] / q)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = next++;
      index.set(key, id);
    }
    faces[v] = id;
  }
  return { faces, vertexCount: next };
}

function cross(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

// Volume, centroid and inertia of the solid a closed, outward-oriented
// mesh bounds, by the divergence theorem over its triangles (Eberly,
// "Polyhedral Mass Properties (Revisited)", 2002). The volume is the sum of
// signed tetrahedra from the origin, so an inside-out mesh has a negative
// volume and an open one an arbitrary one; `analyseMesh` says which.
export function integrals(t) {
  const sum = new Float64Array(10);
  const sub = (w0, w1, w2) => {
    const temp0 = w0 + w1;
    const f1 = temp0 + w2;
    const temp1 = w0 * w0;
    const temp2 = temp1 + w1 * temp0;
    const f2 = temp2 + w2 * f1;
    const f3 = w0 * temp1 + w1 * temp2 + w2 * f2;
    return { f1, f2, f3, g0: f2 + w0 * (f1 + w0), g1: f2 + w1 * (f1 + w1), g2: f2 + w2 * (f1 + w2) };
  };
  for (let i = 0; i < t.length; i += 9) {
    const [x0, y0, z0, x1, y1, z1, x2, y2, z2] = t.subarray(i, i + 9);
    const [d0, d1, d2] = cross(x1 - x0, y1 - y0, z1 - z0, x2 - x0, y2 - y0, z2 - z0);
    const x = sub(x0, x1, x2);
    const y = sub(y0, y1, y2);
    const z = sub(z0, z1, z2);
    sum[0] += d0 * x.f1;
    sum[1] += d0 * x.f2;
    sum[2] += d1 * y.f2;
    sum[3] += d2 * z.f2;
    sum[4] += d0 * x.f3;
    sum[5] += d1 * y.f3;
    sum[6] += d2 * z.f3;
    sum[7] += d0 * (y0 * x.g0 + y1 * x.g1 + y2 * x.g2);
    sum[8] += d1 * (z0 * y.g0 + z1 * y.g1 + z2 * y.g2);
    sum[9] += d2 * (x0 * z.g0 + x1 * z.g1 + x2 * z.g2);
  }
  const scale = [1 / 6, 1 / 24, 1 / 24, 1 / 24, 1 / 60, 1 / 60, 1 / 60, 1 / 120, 1 / 120, 1 / 120];
  for (let k = 0; k < 10; k += 1) sum[k] *= scale[k];

  const volume = sum[0];
  if (volume === 0) return { volume: 0, centroid: null, inertia: null };
  const c = [sum[1] / volume, sum[2] / volume, sum[3] / volume];
  // Inertia about the centroid for unit density (multiply by the density to
  // get a mass moment of inertia).
  const xx = sum[5] + sum[6] - volume * (c[1] * c[1] + c[2] * c[2]);
  const yy = sum[4] + sum[6] - volume * (c[2] * c[2] + c[0] * c[0]);
  const zz = sum[4] + sum[5] - volume * (c[0] * c[0] + c[1] * c[1]);
  const xy = -(sum[7] - volume * c[0] * c[1]);
  const yz = -(sum[8] - volume * c[1] * c[2]);
  const xz = -(sum[9] - volume * c[2] * c[0]);
  return { volume, centroid: c, inertia: [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]] };
}

// Everything `cad.inspect` reports about a mesh, and what the
// `cad.valid_geometry` verifier decides on.
export function analyseMesh(t) {
  const triangleCount = t.length / 9;
  const box = boundingBox(t);
  const { faces, vertexCount } = weld(t, box);
  const areaEps = (diagonal(box) * 1e-9) ** 2;

  let area = 0;
  let degenerate = 0;
  // Undirected edge → [uses, uses in the a<b direction].
  const edges = new Map();
  for (let f = 0; f < triangleCount; f += 1) {
    const i = f * 9;
    const [nx, ny, nz] = cross(t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2], t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2]);
    const twice = Math.hypot(nx, ny, nz);
    area += twice / 2;
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    if (a === b || b === c || a === c || twice / 2 <= areaEps) degenerate += 1;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (p === q) continue;
      // vertexCount² stays far below 2^53 for any mesh under the size limit.
      const key = p < q ? p * vertexCount + q : q * vertexCount + p;
      const entry = edges.get(key) ?? [0, 0];
      entry[0] += 1;
      if (p < q) entry[1] += 1;
      edges.set(key, entry);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (const [uses, forward] of edges.values()) {
    if (uses === 1) boundaryEdges += 1;
    else if (uses > 2) nonManifoldEdges += 1;
    // A closed, consistently oriented surface walks each edge once each way.
    else if (forward !== 1) inconsistentEdges += 1;
  }
  const watertight = boundaryEdges === 0 && nonManifoldEdges === 0;
  const { volume, centroid, inertia } = integrals(t);

  return {
    triangles: triangleCount,
    vertices: vertexCount,
    edges: edges.size,
    boundingBox: { min: box.min.map((v) => round(v)), max: box.max.map((v) => round(v)), size: box.size.map((v) => round(v)) },
    surfaceArea: round(area),
    // Meaningful only for a closed mesh; reported either way, flagged below.
    volume: round(Math.abs(volume)),
    signedVolume: round(volume),
    centroid: centroid ? centroid.map((v) => round(v)) : null,
    inertia,
    watertight,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    consistentOrientation: inconsistentEdges === 0,
    // Outward normals give a positive volume; a negative one means the
    // facets are wound inside out.
    inverted: watertight && volume < 0,
    degenerateTriangles: degenerate,
  };
}

// What makes a mesh usable as a solid. Each problem is a sentence a step
// node can carry.
export function geometryProblems(analysis) {
  const problems = [];
  if (!analysis.watertight) {
    problems.push(`not watertight: ${analysis.boundaryEdges} open edge(s), ${analysis.nonManifoldEdges} edge(s) shared by more than two faces`);
  }
  if (!analysis.consistentOrientation) problems.push(`${analysis.inconsistentEdges} edge(s) where neighbouring faces are wound in opposite directions`);
  if (analysis.degenerateTriangles > 0) problems.push(`${analysis.degenerateTriangles} degenerate (zero-area) triangle(s)`);
  if (analysis.inverted) problems.push('the facets are wound inside out (negative volume)');
  else if (!(analysis.signedVolume > 0)) problems.push('the enclosed volume is not positive');
  return problems;
}

// ---------------------------------------------------------------------------
// Cross-sections: where the mesh crosses a plane, as closed loops. Holes in
// a plate are the loops nested inside another, which is how a hole's centre,
// size and the wall around it are measured from a mesh alone.

const AXES = { x: 0, y: 1, z: 2 };
// The two in-plane coordinates for each axis, chosen so (u, v, axis) is
// right-handed and loop orientation means the same thing on every axis.
const PLANE = { x: [1, 2], y: [2, 0], z: [0, 1] };

function polygonArea(points) {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    twice += x0 * y1 - x1 * y0;
  }
  return twice / 2;
}

function polygonCentroid(points, area) {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  return area === 0 ? points[0] : [cx / (6 * area), cy / (6 * area)];
}

export function pointInPolygon([px, py], points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const s = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + s * dx), py - (ay + s * dy));
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentDistance(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

export function loopDistance(p, q) {
  let best = Infinity;
  for (let i = 0; i < p.length; i += 1) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    for (let j = 0; j < q.length; j += 1) {
      const d = segmentDistance(a, b, q[j], q[(j + 1) % q.length]);
      if (d < best) best = d;
    }
  }
  return best;
}

const MAX_SECTION_POINTS = 200_000;

// The loops where the mesh crosses the plane `axis = at`. A vertex exactly
// on the plane is treated as lying just above it (a consistent symbolic
// perturbation), so every crossing is through an edge's interior and the
// segments chain into closed loops on a watertight mesh.
export function section(t, { axis = 'z', at } = {}) {
  const k = AXES[axis];
  if (k === undefined) throw new CadError('invalid_input', 'section axis must be x, y or z');
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new CadError('invalid_input', 'section position must be a number');
  const [u, v] = PLANE[axis];
  const box = boundingBox(t);
  const { faces } = weld(t, box);

  const points = new Map();
  const links = new Map();
  const link = (from, to) => {
    if (!links.has(from)) links.set(from, []);
    links.get(from).push(to);
  };
  const above = (vertex) => t[vertex * 3 + k] >= at;
  const crossing = (va, vb) => {
    const a = faces[va];
    const b = faces[vb];
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!points.has(key)) {
      const da = t[va * 3 + k] - at;
      const db = t[vb * 3 + k] - at;
      const s = da / (da - db);
      points.set(key, [t[va * 3 + u] + s * (t[vb * 3 + u] - t[va * 3 + u]), t[va * 3 + v] + s * (t[vb * 3 + v] - t[va * 3 + v])]);
      if (points.size > MAX_SECTION_POINTS) throw new CadError('mesh_too_large', 'the section has too many points');
    }
    return key;
  };

  for (let f = 0; f < t.length / 9; f += 1) {
    const vs = [f * 3, f * 3 + 1, f * 3 + 2];
    const side = vs.map(above);
    if (side[0] === side[1] && side[1] === side[2]) continue;
    const ends = [];
    for (let e = 0; e < 3; e += 1) {
      const a = vs[e];
      const b = vs[(e + 1) % 3];
      if (side[e] !== side[(e + 1) % 3]) ends.push(crossing(a, b));
    }
    if (ends.length === 2 && ends[0] !== ends[1]) {
      link(ends[0], ends[1]);
      link(ends[1], ends[0]);
    }
  }

  // Walk the links into chains; a chain that returns to its start is a loop.
  const visited = new Set();
  const loops = [];
  let open = 0;
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const chain = [start];
    visited.add(start);
    let previous = null;
    let current = start;
    let closed = false;
    for (;;) {
      const next = (links.get(current) ?? []).find((candidate) => candidate !== previous && (!visited.has(candidate) || (candidate === start && chain.length > 2)));
      if (next === undefined) break;
      if (next === start) {
        closed = true;
        break;
      }
      visited.add(next);
      chain.push(next);
      previous = current;
      current = next;
    }
    if (closed && chain.length >= 3) loops.push(chain.map((key) => points.get(key)));
    else open += 1;
  }

  const described = loops.map((loop) => {
    const signed = polygonArea(loop);
    return { points: loop, area: Math.abs(signed), centre: polygonCentroid(loop, signed) };
  });
  for (const loop of described) {
    // Nesting depth: an odd depth is a hole in the region around it.
    loop.depth = described.filter((other) => other !== loop && other.area > loop.area && pointInPolygon(loop.points[0], other.points)).length;
    loop.hole = loop.depth % 2 === 1;
  }

  const to3d = ([pu, pv]) => {
    const p = [0, 0, 0];
    p[u] = pu;
    p[v] = pv;
    p[k] = at;
    return p.map((value) => round(value));
  };
  const holes = described.filter((loop) => loop.hole);
  const holeInfo = holes.map((loop) => {
    const wall = Math.min(...described.filter((other) => other !== loop).map((other) => loopDistance(loop.points, other.points)));
    return {
      centre: to3d(loop.centre),
      area: round(loop.area),
      diameter: round(2 * Math.sqrt(loop.area / Math.PI)),
      wall: round(Number.isFinite(wall) ? wall : 0),
    };
  });
  const spacings = [];
  for (let i = 0; i < holes.length; i += 1) {
    for (let j = i + 1; j < holes.length; j += 1) {
      spacings.push(round(Math.hypot(holes[i].centre[0] - holes[j].centre[0], holes[i].centre[1] - holes[j].centre[1])));
    }
  }
  return {
    axis,
    at: round(at),
    loops: described.length,
    openChains: open,
    regions: described.filter((loop) => !loop.hole).length,
    area: round(described.reduce((sum, loop) => sum + (loop.hole ? -loop.area : loop.area), 0)),
    holes: holeInfo,
    holeSpacings: spacings.sort((a, b) => a - b),
  };
}

export function midPlane(t, axis = 'z') {
  const k = AXES[axis];
  if (k === undefined) throw new CadError('invalid_input', 'section axis must be x, y or z');
  const box = boundingBox(t);
  return (box.min[k] + box.max[k]) / 2;
}
