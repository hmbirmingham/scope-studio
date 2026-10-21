// Small solids as triangle soups (nine numbers per triangle), built from
// unit cells on a grid so every mesh is exactly watertight with no
// T-junctions. Used by generate.mjs to write the fixture files and by the
// tests to build variants (inverted, offset) on the fly.

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function crossProduct(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Two triangles for the quad a-b-c-d, wound so their normal points along
// `outward`.
function quad(out, a, b, c, d, outward) {
  const n = crossProduct(sub(b, a), sub(c, a));
  const flip = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0;
  const tris = flip ? [[a, c, b], [a, d, c]] : [[a, b, c], [a, c, d]];
  for (const tri of tris) for (const p of tri) out.push(...p);
}

// A plate made of `cells` (a set of "i,j" keys) of size `cell`, extruded
// from z = z0 to z = z0 + height.
export function extrudeCells(cells, { cell = 1, height = 1, origin = [0, 0, 0] } = {}) {
  const set = new Set(cells);
  const out = [];
  const [ox, oy, oz] = origin;
  const z0 = oz;
  const z1 = oz + height;
  for (const key of set) {
    const [i, j] = key.split(',').map(Number);
    const x0 = ox + i * cell, x1 = x0 + cell, y0 = oy + j * cell, y1 = y0 + cell;
    quad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    quad(out, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
    if (!set.has(`${i - 1},${j}`)) quad(out, [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0]);
    if (!set.has(`${i + 1},${j}`)) quad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
    if (!set.has(`${i},${j - 1}`)) quad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
    if (!set.has(`${i},${j + 1}`)) quad(out, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]);
  }
  return Float64Array.from(out);
}

export function box(size, origin = [0, 0, 0]) {
  const [sx, sy, sz] = Array.isArray(size) ? size : [size, size, size];
  const [ox, oy, oz] = origin;
  const out = [];
  const p = (x, y, z) => [ox + x * sx, oy + y * sy, oz + z * sz];
  quad(out, p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1), [0, 0, 1]);
  quad(out, p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0), [0, 0, -1]);
  quad(out, p(0, 0, 0), p(0, 1, 0), p(0, 1, 1), p(0, 0, 1), [-1, 0, 0]);
  quad(out, p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1), [1, 0, 0]);
  quad(out, p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1), [0, -1, 0]);
  quad(out, p(0, 1, 0), p(1, 1, 0), p(1, 1, 1), p(0, 1, 1), [0, 1, 0]);
  return Float64Array.from(out);
}

// A 60 × 20 × 5 mm mounting bracket on a 5 mm grid with two 5 mm square
// holes whose centres are 40 mm apart, each with 5 mm of material to the
// plate's edges.
export function bracket({ spacingCells = 8 } = {}) {
  const cells = [];
  for (let i = 0; i < 12; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      if (j === 1 && (i === 1 || i === 1 + spacingCells)) continue;
      cells.push(`${i},${j}`);
    }
  }
  return extrudeCells(cells, { cell: 5, height: 5 });
}

// The same box with every triangle wound the other way.
export function inverted(triangles) {
  const out = Float64Array.from(triangles);
  for (let i = 0; i < out.length; i += 9) {
    for (let k = 0; k < 3; k += 1) [out[i + 3 + k], out[i + 6 + k]] = [out[i + 6 + k], out[i + 3 + k]];
  }
  return out;
}

// Drops the triangles whose three vertices all have coordinate `axis` equal
// to `value` (removes a face, leaving the mesh open).
export function withoutFace(triangles, axis, value) {
  const keep = [];
  for (let i = 0; i < triangles.length; i += 9) {
    const on = [0, 1, 2].every((v) => triangles[i + v * 3 + axis] === value);
    if (!on) keep.push(...triangles.subarray(i, i + 9));
  }
  return Float64Array.from(keep);
}

// A hand-written STEP AP214 product structure: an assembly that uses a
// bracket once and a bolt twice, in millimetres, with no geometry.
export function assemblyStep() {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Scope Studio CAD fixture: bracket assembly'),'2;1');
FILE_NAME('bracket-assembly.step','2026-01-01T00:00:00',('Scope Studio'),('Scope Studio'),'fixture generator','generate.mjs','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
/* the application context every product refers to */
#1=APPLICATION_CONTEXT('automotive design');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#10=PRODUCT('ASM-1','Bracket assembly','A bracket bolted down; it''s the root',(#2));
#11=PRODUCT_DEFINITION_FORMATION('','',#10);
#12=PRODUCT_DEFINITION('design','',#11,#3);
#20=PRODUCT('BRK-1','Bracket','Mounting bracket',(#2));
#21=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#20,.NOT_KNOWN.);
#22=PRODUCT_DEFINITION('design','',#21,#3);
#30=PRODUCT('BLT-M4','M4 bolt','ISO 4762 M4x12',(#2));
#31=PRODUCT_DEFINITION_FORMATION('','',#30);
#32=PRODUCT_DEFINITION('design','',#31,#3);
#40=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','Bracket','',#12,#22,$);
#41=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','Bolt 1','',#12,#32,$);
#42=NEXT_ASSEMBLY_USAGE_OCCURRENCE('3','Bolt 2','',#12,#32,$);
#50=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#51=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#52=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#50,'distance_accuracy_value','confusion accuracy');
ENDSEC;
END-ISO-10303-21;
`;
}
