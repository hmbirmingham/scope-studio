import { CadError } from './errors.js';
import { boundingBox } from './mesh.js';
import { round } from './units.js';

// Whether two triangle meshes interfere, in JavaScript: a bounding-box
// prefilter, a uniform grid over the region where the boxes overlap, then an
// exact triangle-triangle test. Parts that only touch (a face resting flush
// on another, an edge on a face) do not interfere; surfaces that cross do,
// and so does one closed part sitting entirely inside another, and so do
// closed parts whose volumes overlap while every face lies in a shared plane
// (parts aligned on datum planes, or two copies of the same part).

// Candidate triangle pairs one check may test before it gives up rather
// than hold a step for minutes.
const MAX_PAIR_TESTS = 50_000_000;
const CONTAINMENT_SAMPLES = 32;
// Point-in-mesh work (triangles visited) the overlapping-volume check may
// spend: each sample point costs a few passes over both meshes, so large
// meshes get fewer samples rather than a stalled step.
const MAX_POINT_WORK = 40_000_000;
const OVERLAP_SAMPLES = 256;
const REGION_SAMPLES_PER_AXIS = 3;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

function vertex(t, i, k) {
  return [t[i + k * 3], t[i + k * 3 + 1], t[i + k * 3 + 2]];
}

// The segment where triangle `p` meets the plane through `q0` with normal
// `n`, given the vertices' signed distances (already snapped to zero within
// tolerance), projected onto direction `axis`.
function interval(p, d, axis) {
  const values = [];
  for (let i = 0; i < 3; i += 1) {
    if (d[i] === 0) values.push(dot(p[i], axis));
    const j = (i + 1) % 3;
    if ((d[i] > 0 && d[j] < 0) || (d[i] < 0 && d[j] > 0)) {
      const s = d[i] / (d[i] - d[j]);
      values.push(dot([p[i][0] + s * (p[j][0] - p[i][0]), p[i][1] + s * (p[j][1] - p[i][1]), p[i][2] + s * (p[j][2] - p[i][2])], axis));
    }
  }
  return [Math.min(...values), Math.max(...values)];
}

function distances(p, origin, normal, eps) {
  const scaled = eps * norm(normal);
  return p.map((point) => {
    const d = dot(normal, sub(point, origin));
    return Math.abs(d) <= scaled ? 0 : d;
  });
}

const straddles = (d) => d.some((x) => x > 0) && d.some((x) => x < 0);

// True when the two triangles' interiors cross each other by more than
// `eps`. Coplanar and merely touching triangles do not cross.
export function trianglesCross(a, b, eps) {
  const nb = cross(sub(b[1], b[0]), sub(b[2], b[0]));
  const na = cross(sub(a[1], a[0]), sub(a[2], a[0]));
  if (norm(na) === 0 || norm(nb) === 0) return false;
  const da = distances(a, b[0], nb, eps);
  if (!straddles(da)) return false;
  const db = distances(b, a[0], na, eps);
  if (!straddles(db)) return false;
  const line = cross(na, nb);
  const length = norm(line);
  if (length === 0) return false;
  const axis = [line[0] / length, line[1] / length, line[2] / length];
  const [a0, a1] = interval(a, da, axis);
  const [b0, b1] = interval(b, db, axis);
  return Math.min(a1, b1) - Math.max(a0, b0) > eps;
}

function triBox(t, i) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < 3; v += 1) {
    for (let k = 0; k < 3; k += 1) {
      const value = t[i + v * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }
  return { min, max };
}

const boxesOverlap = (a, b, eps) => [0, 1, 2].every((k) => a.min[k] <= b.max[k] + eps && b.min[k] <= a.max[k] + eps);

// Closest distance from a point to a triangle (Ericson, Real-Time Collision
// Detection, 5.1.5).
export function pointTriangleDistance(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return norm(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return norm(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return norm(sub(p, [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return norm(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return norm(sub(p, [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return norm(sub(p, [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return norm(sub(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]));
}

// Möller–Trumbore: where the ray from `origin` along `dir` meets the
// triangle at a positive distance. Returns 0 for a miss, 1 for a clean hit
// and -1 when the ray passes within a hair of the triangle's edge or corner:
// there the neighbouring triangle may or may not count the same crossing, so
// the ray's parity cannot be trusted.
const EDGE = 1e-9;
function rayHits(origin, dir, a, b, c) {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-18) return 0;
  const inv = 1 / det;
  const s = sub(origin, a);
  const u = dot(s, p) * inv;
  if (u < -EDGE || u > 1 + EDGE) return 0;
  const q = cross(s, e1);
  const v = dot(dir, q) * inv;
  if (v < -EDGE || u + v > 1 + EDGE) return 0;
  if (dot(e2, q) * inv <= 0) return 0;
  return u < EDGE || v < EDGE || u + v > 1 - EDGE ? -1 : 1;
}

// Directions with no small-integer ratios between their components, so a
// ray from a point on a grid rarely runs exactly through a grid-aligned
// edge. A ray that grazes an edge anyway is discarded and the next one
// tried; three clean rays vote.
const RAYS = [
  [0.5910502691896258, 0.5702502691896257, 0.5802502691896259],
  [-0.3517935279, 0.7613408257, 0.5446128349],
  [0.7934102756, -0.2817370561, -0.5395837162],
  [0.1218469721, -0.6830213954, 0.7201846385],
  [-0.6602711498, -0.4113906763, -0.6283510737],
  [0.4472659141, 0.1931270318, -0.8733312079],
  [-0.8231504067, 0.3197201383, -0.4693385129],
];

export function pointInsideMesh(point, t) {
  let votes = 0;
  let clean = 0;
  for (const dir of RAYS) {
    let hits = 0;
    let grazed = false;
    for (let i = 0; i < t.length && !grazed; i += 9) {
      const hit = rayHits(point, dir, vertex(t, i, 0), vertex(t, i, 1), vertex(t, i, 2));
      if (hit === -1) grazed = true;
      else hits += hit;
    }
    if (grazed) continue;
    clean += 1;
    if (hits % 2 === 1) votes += 1;
    if (clean === 3) break;
  }
  return clean > 0 && votes * 2 > clean;
}

function surfaceDistance(point, t) {
  let best = Infinity;
  for (let i = 0; i < t.length; i += 9) {
    const d = pointTriangleDistance(point, vertex(t, i, 0), vertex(t, i, 1), vertex(t, i, 2));
    if (d < best) best = d;
  }
  return best;
}

// Whether some vertex of `inner` lies strictly inside the closed mesh
// `outer`: the case where no surfaces cross because one part is wholly
// inside the other.
function contained(inner, outer, eps) {
  const count = inner.length / 3;
  const step = Math.max(1, Math.floor(count / CONTAINMENT_SAMPLES));
  for (let v = 0; v < count; v += step) {
    const point = [inner[v * 3], inner[v * 3 + 1], inner[v * 3 + 2]];
    if (surfaceDistance(point, outer) > eps && pointInsideMesh(point, outer)) return true;
  }
  return false;
}

// The sign of the mesh's signed volume: positive when the triangles wind
// counter-clockwise seen from outside, so their right-hand normals point out.
function orientation(t) {
  let six = 0;
  for (let i = 0; i < t.length; i += 9) {
    six += dot(vertex(t, i, 0), cross(vertex(t, i, 1), vertex(t, i, 2)));
  }
  return six < 0 ? -1 : 1;
}

// Points just under the surface of the closed mesh `t`, `depth` in along the
// inward normal: each sampled triangle's centroid and the points halfway from
// it to each corner. Only triangles in `entries` (those near the overlap
// region) are sampled, evenly spread up to `limit` of them.
function pointsJustInside(t, entries, depth, limit) {
  const sign = -orientation(t);
  const points = [];
  const step = Math.max(1, Math.ceil(entries.length / Math.max(1, limit)));
  for (let e = 0; e < entries.length; e += step) {
    const i = entries[e].i;
    const p = [vertex(t, i, 0), vertex(t, i, 1), vertex(t, i, 2)];
    const n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    const length = norm(n);
    if (length === 0) continue;
    const move = (sign * depth) / length;
    const c = [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3);
    for (const q of [c, ...p.map((v) => [0, 1, 2].map((k) => (c[k] + v[k]) / 2))]) {
      points.push([q[0] + n[0] * move, q[1] + n[1] * move, q[2] + n[2] * move]);
    }
  }
  return points;
}

// Whether `point` is inside the closed mesh `t` and further than `eps` from
// its surface, so a point on a shared face never counts.
const strictlyInside = (point, t, eps) => pointInsideMesh(point, t) && surfaceDistance(point, t) > eps;

// Closed parts whose surfaces never cross can still share volume when their
// faces lie in the same planes: two copies of one part, a box inside a taller
// box sharing its sides, boxes overlapping along one axis only. Then no
// vertex is strictly inside the other part either, so sample points that are
// strictly inside one part (just under its faces, and a grid over the
// bounding-box overlap) and look for one strictly inside both.
function volumesOverlap(a, b, candA, candB, region, eps) {
  const extent = region.max.map((max, k) => max - region.min[k] - 2 * eps);
  if (extent.some((e) => e <= eps)) return false;
  const triangles = (a.triangles.length + b.triangles.length) / 9;
  // Each point costs up to three ray casts and a distance pass per mesh.
  const budget = Math.max(16, Math.floor(MAX_POINT_WORK / (7 * triangles)));
  const both = (point) => strictlyInside(point, b.triangles, eps) && strictlyInside(point, a.triangles, eps);

  const n = REGION_SAMPLES_PER_AXIS;
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < n; y += 1) {
      for (let z = 0; z < n; z += 1) {
        const point = [x, y, z].map((s, k) => region.min[k] + eps + ((s + 0.5) / n) * extent[k]);
        if (both(point)) return true;
      }
    }
  }
  // Deep enough to clear the tolerance, shallow enough to stay inside any
  // feature thicker than a ten-thousandth of the overlap.
  const depth = Math.max(eps * 10, Math.min(...extent) * 1e-4);
  const perMesh = Math.min(OVERLAP_SAMPLES, Math.floor(budget / 8));
  for (const [own, other, entries] of [[a, b, candA], [b, a, candB]]) {
    for (const point of pointsJustInside(own.triangles, entries, depth, perMesh)) {
      if (strictlyInside(point, other.triangles, eps) && pointInsideMesh(point, own.triangles)) return true;
    }
  }
  return false;
}

function boxInside(inner, outer, eps) {
  return [0, 1, 2].every((k) => inner.min[k] >= outer.min[k] - eps && inner.max[k] <= outer.max[k] + eps);
}

// `a` and `b` are `{ triangles, watertight }`. `tolerance` is in the meshes'
// own unit; by default a millionth of the larger part's diagonal.
export function meshInterference(a, b, { tolerance } = {}) {
  const boxA = boundingBox(a.triangles);
  const boxB = boundingBox(b.triangles);
  const scale = Math.max(Math.hypot(...boxA.size), Math.hypot(...boxB.size));
  const eps = tolerance ?? scale * 1e-6;
  const result = { interferes: false, reason: null, crossingPairs: 0, pairsTested: 0, tolerance: round(eps), boundingBoxesOverlap: boxesOverlap(boxA, boxB, -eps) };
  if (!result.boundingBoxesOverlap) return result;

  const region = {
    min: [0, 1, 2].map((k) => Math.max(boxA.min[k], boxB.min[k]) - eps),
    max: [0, 1, 2].map((k) => Math.min(boxA.max[k], boxB.max[k]) + eps),
  };
  const pick = (t) => {
    const list = [];
    for (let i = 0; i < t.length; i += 9) {
      const box = triBox(t, i);
      if (boxesOverlap(box, region, 0)) list.push({ i, box });
    }
    return list;
  };
  const candA = pick(a.triangles);
  const candB = pick(b.triangles);

  // A uniform grid over the overlap region, about one B triangle per cell.
  const cells = Math.max(1, Math.min(64, Math.ceil(Math.cbrt(candB.length))));
  const size = region.max.map((max, k) => Math.max((max - region.min[k]) / cells, 1e-300));
  const cellOf = (value, k) => Math.max(0, Math.min(cells - 1, Math.floor((value - region.min[k]) / size[k])));
  const grid = new Map();
  candB.forEach((entry, index) => {
    for (let x = cellOf(entry.box.min[0], 0); x <= cellOf(entry.box.max[0], 0); x += 1) {
      for (let y = cellOf(entry.box.min[1], 1); y <= cellOf(entry.box.max[1], 1); y += 1) {
        for (let z = cellOf(entry.box.min[2], 2); z <= cellOf(entry.box.max[2], 2); z += 1) {
          const key = (x * cells + y) * cells + z;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(index);
        }
      }
    }
  });

  const seen = new Int32Array(candB.length).fill(-1);
  candA.forEach((entry, aIndex) => {
    const triA = [vertex(a.triangles, entry.i, 0), vertex(a.triangles, entry.i, 1), vertex(a.triangles, entry.i, 2)];
    for (let x = cellOf(entry.box.min[0], 0); x <= cellOf(entry.box.max[0], 0); x += 1) {
      for (let y = cellOf(entry.box.min[1], 1); y <= cellOf(entry.box.max[1], 1); y += 1) {
        for (let z = cellOf(entry.box.min[2], 2); z <= cellOf(entry.box.max[2], 2); z += 1) {
          for (const bIndex of grid.get((x * cells + y) * cells + z) ?? []) {
            if (seen[bIndex] === aIndex) continue;
            seen[bIndex] = aIndex;
            const other = candB[bIndex];
            if (!boxesOverlap(entry.box, other.box, eps)) continue;
            result.pairsTested += 1;
            if (result.pairsTested > MAX_PAIR_TESTS) {
              throw new CadError('too_complex', `the interference check exceeded ${MAX_PAIR_TESTS} triangle pairs; simplify the meshes`);
            }
            const triB = [vertex(b.triangles, other.i, 0), vertex(b.triangles, other.i, 1), vertex(b.triangles, other.i, 2)];
            if (trianglesCross(triA, triB, eps)) result.crossingPairs += 1;
          }
        }
      }
    }
  });

  if (result.crossingPairs > 0) {
    result.interferes = true;
    result.reason = 'surfaces_cross';
    return result;
  }
  // No surfaces cross: either the parts are apart (or touching), or one is
  // wholly inside the other. Only a closed mesh has an inside.
  if (b.watertight && boxInside(boxA, boxB, eps) && contained(a.triangles, b.triangles, eps)) {
    result.interferes = true;
    result.reason = 'a_inside_b';
  } else if (a.watertight && boxInside(boxB, boxA, eps) && contained(b.triangles, a.triangles, eps)) {
    result.interferes = true;
    result.reason = 'b_inside_a';
  } else if (a.watertight && b.watertight && volumesOverlap(a, b, candA, candB, region, eps)) {
    result.interferes = true;
    result.reason = 'volumes_overlap';
  }
  return result;
}
