import { CadError } from './errors.js';

// STL, ASCII and binary, read in JavaScript so inspecting a mesh needs no
// external tool. A mesh is `{ format, name, triangles: Float64Array }` with
// nine numbers per triangle (three vertices, x y z each). Facet normals in
// the file are ignored: the vertex order is what defines the orientation,
// and many exporters write zero or stale normals.

export const MAX_STL_BYTES = 64 * 1024 * 1024;
export const MAX_TRIANGLES = 1_000_000;

const HEADER_BYTES = 80;
const RECORD_BYTES = 50;

function isBinary(buffer) {
  if (buffer.length < HEADER_BYTES + 4) return false;
  const count = buffer.readUInt32LE(HEADER_BYTES);
  // The size is fully determined by the count, which an ASCII file
  // (starting with "solid") essentially never satisfies by accident. Some
  // exporters pad a few bytes at the end, so a little slack is allowed.
  const expected = HEADER_BYTES + 4 + count * RECORD_BYTES;
  return buffer.length >= expected && buffer.length - expected < RECORD_BYTES;
}

function parseBinary(buffer) {
  const count = buffer.readUInt32LE(HEADER_BYTES);
  if (count > MAX_TRIANGLES) throw new CadError('mesh_too_large', `the mesh has ${count} triangles; the limit is ${MAX_TRIANGLES}`);
  const header = buffer.subarray(0, HEADER_BYTES).toString('latin1').replace(/\0+$/, '').trim();
  const triangles = new Float64Array(count * 9);
  for (let i = 0; i < count; i += 1) {
    // 12 bytes of normal, then three vertices of three float32s.
    const base = HEADER_BYTES + 4 + i * RECORD_BYTES + 12;
    for (let k = 0; k < 9; k += 1) triangles[i * 9 + k] = buffer.readFloatLE(base + k * 4);
  }
  return { format: 'binary', name: header.replace(/^solid\s*/i, '') || null, triangles };
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function parseAscii(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens[0]?.toLowerCase() !== 'solid') throw new CadError('invalid_stl', 'an ASCII STL starts with "solid"');
  let i = 1;
  const nameParts = [];
  while (i < tokens.length && tokens[i].toLowerCase() !== 'facet' && tokens[i].toLowerCase() !== 'endsolid') nameParts.push(tokens[i++]);

  const values = [];
  let facets = 0;
  let inFacet = false;
  let vertices = 0;
  for (; i < tokens.length; i += 1) {
    const word = tokens[i].toLowerCase();
    if (word === 'facet') {
      if (inFacet) throw new CadError('invalid_stl', `facet ${facets + 1} is not closed`);
      inFacet = true;
      vertices = 0;
    } else if (word === 'vertex') {
      if (!inFacet) throw new CadError('invalid_stl', 'a vertex outside a facet');
      for (let k = 1; k <= 3; k += 1) {
        const token = tokens[i + k];
        if (!token || !NUMBER.test(token)) throw new CadError('invalid_stl', `facet ${facets + 1} has a malformed vertex`);
        values.push(Number(token));
      }
      i += 3;
      vertices += 1;
    } else if (word === 'endfacet') {
      if (!inFacet || vertices !== 3) throw new CadError('invalid_stl', `facet ${facets + 1} must have exactly three vertices`);
      inFacet = false;
      facets += 1;
      if (facets > MAX_TRIANGLES) throw new CadError('mesh_too_large', `the mesh has more than ${MAX_TRIANGLES} triangles`);
    } else if (word === 'endsolid') {
      break;
    }
    // "normal nx ny nz", "outer loop" and "endloop" carry nothing we use; a
    // normal's numbers are skipped as the loop walks past them.
  }
  if (inFacet) throw new CadError('invalid_stl', 'the file ends inside a facet');
  return { format: 'ascii', name: nameParts.join(' ') || null, triangles: Float64Array.from(values) };
}

export function parseStl(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > MAX_STL_BYTES) throw new CadError('file_too_large', `STL files are limited to ${MAX_STL_BYTES} bytes`);
  const mesh = isBinary(buffer) ? parseBinary(buffer) : parseAscii(buffer.toString('latin1'));
  for (const value of mesh.triangles) {
    if (!Number.isFinite(value)) throw new CadError('invalid_stl', 'the mesh has a non-finite coordinate');
  }
  if (mesh.triangles.length === 0) throw new CadError('invalid_stl', 'the mesh has no triangles');
  return mesh;
}

function normalOf(t, i) {
  const ax = t[i + 3] - t[i], ay = t[i + 4] - t[i + 1], az = t[i + 5] - t[i + 2];
  const bx = t[i + 6] - t[i], by = t[i + 7] - t[i + 1], bz = t[i + 8] - t[i + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

// Binary STL, for fixtures and for meshes a capability writes.
export function encodeBinaryStl(triangles, { name = 'scope-studio' } = {}) {
  const count = triangles.length / 9;
  const buffer = Buffer.alloc(HEADER_BYTES + 4 + count * RECORD_BYTES);
  buffer.write(name.slice(0, HEADER_BYTES), 0, 'latin1');
  buffer.writeUInt32LE(count, HEADER_BYTES);
  for (let i = 0; i < count; i += 1) {
    const base = HEADER_BYTES + 4 + i * RECORD_BYTES;
    const normal = normalOf(triangles, i * 9);
    for (let k = 0; k < 3; k += 1) buffer.writeFloatLE(normal[k], base + k * 4);
    for (let k = 0; k < 9; k += 1) buffer.writeFloatLE(triangles[i * 9 + k], base + 12 + k * 4);
  }
  return buffer;
}

export function encodeAsciiStl(triangles, { name = 'scope-studio' } = {}) {
  const lines = [`solid ${name}`];
  const fmt = (value) => String(Number(value.toPrecision(9)));
  for (let i = 0; i < triangles.length; i += 9) {
    lines.push(`  facet normal ${normalOf(triangles, i).map(fmt).join(' ')}`, '    outer loop');
    for (let k = 0; k < 9; k += 3) lines.push(`      vertex ${fmt(triangles[i + k])} ${fmt(triangles[i + k + 1])} ${fmt(triangles[i + k + 2])}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`, '');
  return lines.join('\n');
}
