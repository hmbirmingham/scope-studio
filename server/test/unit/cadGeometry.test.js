import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { meshInterference, pointInsideMesh, trianglesCross } from '../../src/plugins/cad/interference.js';
import { evaluateChecks, validateChecks } from '../../src/plugins/cad/measure.js';
import { analyseMesh, geometryProblems, integrals, section } from '../../src/plugins/cad/mesh.js';
import { parseStep, readStep } from '../../src/plugins/cad/step.js';
import { MAX_TRIANGLES, encodeAsciiStl, encodeBinaryStl, parseStl } from '../../src/plugins/cad/stl.js';
import { convertLength, densityToSi, lengthUnit } from '../../src/plugins/cad/units.js';
import { box, bracket, extrudeCells, inverted, withoutFace } from '../fixtures/cad/shapes.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'cad');
const fixture = (name) => readFileSync(join(FIXTURES, name));
const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `${actual} ≉ ${expected}`);
const solid = (triangles) => ({ triangles, watertight: analyseMesh(triangles).watertight });

describe('STL reading', () => {
  test('binary and ASCII fixtures read to the same cube', () => {
    const binary = parseStl(fixture('cube.stl'));
    const ascii = parseStl(fixture('cube-ascii.stl'));
    assert.equal(binary.format, 'binary');
    assert.equal(ascii.format, 'ascii');
    assert.equal(ascii.name, 'cube');
    assert.equal(binary.triangles.length, 12 * 9);
    assert.deepEqual(Array.from(ascii.triangles), Array.from(binary.triangles));
  });

  test('round-trips through both encoders', () => {
    const triangles = bracket();
    assert.deepEqual(Array.from(parseStl(encodeBinaryStl(triangles)).triangles), Array.from(triangles));
    assert.deepEqual(Array.from(parseStl(Buffer.from(encodeAsciiStl(triangles))).triangles), Array.from(triangles));
  });

  test('an ASCII file that begins "solid" but is sized like a binary one is still read by its size', () => {
    // An 80-byte header that starts with "solid", as some binary exporters write.
    const buffer = encodeBinaryStl(box(1), { name: 'solid from a binary exporter' });
    assert.equal(parseStl(buffer).format, 'binary');
  });

  test('refuses malformed files with a code, never a partial mesh', () => {
    const cases = [
      ['solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\nendsolid', /exactly three vertices/],
      ['solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 zero\n', /malformed vertex/],
      ['solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n', /ends inside a facet/],
      ['solid empty\nendsolid empty\n', /no triangles/],
      ['not an stl at all', /starts with "solid"/],
    ];
    for (const [text, message] of cases) {
      assert.throws(() => parseStl(Buffer.from(text)), (err) => err.code && message.test(err.message), text);
    }
    const nan = encodeBinaryStl(box(1));
    nan.writeFloatLE(Number.NaN, 84 + 12);
    assert.throws(() => parseStl(nan), /non-finite/);
  });

  test('refuses a binary file that claims more triangles than the limit', () => {
    const header = Buffer.alloc(84);
    header.writeUInt32LE(MAX_TRIANGLES + 1, 80);
    const buffer = Buffer.concat([header, Buffer.alloc((MAX_TRIANGLES + 1) * 50)]);
    assert.throws(() => parseStl(buffer), (err) => err.code === 'mesh_too_large');
  });
});

describe('mesh analysis', () => {
  test('a 10 mm cube: volume, area, centroid, inertia and watertightness', () => {
    const analysis = analyseMesh(parseStl(fixture('cube.stl')).triangles);
    assert.equal(analysis.volume, 1000);
    assert.equal(analysis.surfaceArea, 600);
    assert.deepEqual(analysis.centroid, [5, 5, 5]);
    assert.deepEqual(analysis.boundingBox.size, [10, 10, 10]);
    assert.equal(analysis.watertight, true);
    assert.equal(analysis.consistentOrientation, true);
    assert.equal(analysis.vertices, 8);
    assert.deepEqual(geometryProblems(analysis), []);
    // A cube of side a and unit density: I = V a² / 6 about each axis, no products.
    close(analysis.inertia[0][0], (1000 * 100) / 6);
    close(analysis.inertia[1][1], (1000 * 100) / 6);
    close(analysis.inertia[2][2], (1000 * 100) / 6);
    close(analysis.inertia[0][1], 0);
  });

  test('a box: inertia matches the closed form, wherever the box sits', () => {
    const { volume, centroid, inertia } = integrals(box([2, 3, 4], [10, -7, 3]));
    close(volume, 24);
    assert.deepEqual(centroid.map((v) => Number(v.toFixed(12))), [11, -5.5, 5]);
    close(inertia[0][0], (24 * (9 + 16)) / 12);
    close(inertia[1][1], (24 * (4 + 16)) / 12);
    close(inertia[2][2], (24 * (4 + 9)) / 12);
  });

  test('the bracket fixture: holes reduce the volume and the area adds their walls', () => {
    const analysis = analyseMesh(parseStl(fixture('bracket.stl')).triangles);
    assert.equal(analysis.volume, 60 * 20 * 5 - 2 * 5 * 5 * 5);
    assert.equal(analysis.watertight, true);
    assert.deepEqual(analysis.boundingBox.size, [60, 20, 5]);
  });

  test('an open mesh is not watertight and says how', () => {
    const analysis = analyseMesh(parseStl(fixture('open-box.stl')).triangles);
    assert.equal(analysis.watertight, false);
    assert.equal(analysis.boundaryEdges, 4);
    assert.match(geometryProblems(analysis).join(), /not watertight: 4 open edge/);
  });

  test('an inside-out mesh has a negative signed volume and is flagged', () => {
    const analysis = analyseMesh(inverted(box(10)));
    assert.equal(analysis.signedVolume, -1000);
    assert.equal(analysis.volume, 1000);
    assert.equal(analysis.inverted, true);
    assert.match(geometryProblems(analysis).join(), /inside out/);
  });

  test('one flipped facet breaks orientation; a zero-area facet is degenerate', () => {
    const triangles = box(10);
    const flipped = Float64Array.from(triangles);
    for (let k = 0; k < 3; k += 1) [flipped[3 + k], flipped[6 + k]] = [flipped[6 + k], flipped[3 + k]];
    assert.equal(analyseMesh(flipped).consistentOrientation, false);
    assert.match(geometryProblems(analyseMesh(flipped)).join(), /opposite directions/);

    const sliver = Float64Array.from([...triangles, 0, 0, 0, 5, 0, 0, 10, 0, 0]);
    const analysis = analyseMesh(sliver);
    assert.equal(analysis.degenerateTriangles, 1);
    assert.match(geometryProblems(analysis).join(), /degenerate/);
  });
});

describe('cross-sections and hole measures', () => {
  test('the bracket at mid-height: two holes 40 mm apart with 5 mm walls', () => {
    const cut = section(parseStl(fixture('bracket.stl')).triangles, { axis: 'z', at: 2.5 });
    assert.equal(cut.loops, 3);
    assert.equal(cut.regions, 1);
    assert.equal(cut.openChains, 0);
    assert.equal(cut.area, 60 * 20 - 2 * 25);
    assert.deepEqual(cut.holes.map((h) => h.centre).sort((a, b) => a[0] - b[0]), [[7.5, 7.5, 2.5], [47.5, 7.5, 2.5]]);
    assert.deepEqual(cut.holeSpacings, [40]);
    assert.deepEqual(cut.holes.map((h) => h.wall), [5, 5]);
  });

  test('a section exactly through a row of vertices still closes its loops', () => {
    const cut = section(bracket(), { axis: 'x', at: 30 });
    assert.equal(cut.openChains, 0);
    assert.equal(cut.loops, 1);
    assert.equal(cut.area, 20 * 5);
  });

  test('a section that misses the part has no loops; a bad axis is refused', () => {
    assert.equal(section(box(10), { axis: 'z', at: 50 }).loops, 0);
    assert.throws(() => section(box(10), { axis: 'w', at: 1 }), (err) => err.code === 'invalid_input');
    assert.throws(() => section(box(10), { axis: 'z', at: Number.NaN }), (err) => err.code === 'invalid_input');
  });

  test('a section too detailed to measure is refused rather than computed for minutes', () => {
    // The nesting and wall-thickness passes are quadratic in the loops' points.
    assert.throws(() => section(bracket(), { axis: 'z', at: 2.5, maxWork: 100 }), (err) => err.code === 'too_complex');
    assert.equal(section(bracket(), { axis: 'z', at: 2.5 }).holes.length, 2);
  });

  test('declared checks pass and fail on what is measured', () => {
    const triangles = parseStl(fixture('bracket.stl')).triangles;
    const results = evaluateChecks(triangles, validateChecks([
      { measure: 'holes.spacing', value: 40, tolerance: 0.01 },
      { measure: 'holes.spacing', value: 50, tolerance: 0.5 },
      { measure: 'holes.minWall', min: 4 },
      { measure: 'holes.count', value: 2 },
      { measure: 'size.x', min: 59.9, max: 60.1 },
      { measure: 'volume', value: 5750, tolerance: 1e-6 },
    ]));
    assert.deepEqual(results.map((r) => r.ok), [true, false, true, true, true, true]);
    assert.equal(results[1].actual, 40);
    assert.equal(results[1].expected, '50 ± 0.5');
  });

  test('a measure with nothing to measure fails rather than passing', () => {
    const [result] = evaluateChecks(box(10), validateChecks([{ measure: 'holes.spacing', min: 0 }]));
    assert.equal(result.actual, null);
    assert.equal(result.ok, false);
  });

  test('malformed checks are refused before anything is measured', () => {
    for (const bad of [[{ measure: 'weight', value: 1 }], [{ measure: 'volume' }], [{ measure: 'volume', value: '5' }], [{ measure: 'volume', value: 1, tolerance: -1 }], 'nope']) {
      assert.throws(() => validateChecks(bad), (err) => err.code === 'invalid_input', JSON.stringify(bad));
    }
  });
});

describe('mesh interference', () => {
  test('overlapping cubes interfere: their surfaces cross', () => {
    const result = meshInterference(solid(parseStl(fixture('overlap-a.stl')).triangles), solid(parseStl(fixture('overlap-b.stl')).triangles));
    assert.equal(result.interferes, true);
    assert.equal(result.reason, 'surfaces_cross');
    assert.ok(result.crossingPairs > 0);
  });

  test('parts that only touch face to face, or along an edge, do not', () => {
    assert.equal(meshInterference(solid(box(10)), solid(parseStl(fixture('touching.stl')).triangles)).interferes, false);
    assert.equal(meshInterference(solid(box(10)), solid(box(10, [10, 10, 0]))).interferes, false);
    // A plate resting on the cube's top face, overlapping it in plan.
    assert.equal(meshInterference(solid(box(10)), solid(box([20, 20, 2], [-5, -5, 10]))).interferes, false);
  });

  test('a part wholly inside another interferes, in either order', () => {
    const outer = solid(box(10));
    const inner = solid(parseStl(fixture('inner.stl')).triangles);
    assert.equal(meshInterference(outer, inner).reason, 'b_inside_a');
    assert.equal(meshInterference(inner, outer).reason, 'a_inside_b');
  });

  test('parts aligned on shared planes still interfere when their volumes overlap', () => {
    // Every face of one part lies in a plane of the other, so no surfaces
    // cross and no vertex is strictly inside: the overlap is in the volume.
    const cube = solid(box(10));
    const cases = [
      ['an identical copy', solid(box(10))],
      ['a taller box sharing four sides and the base', solid(box([10, 10, 20]))],
      ['a box overlapping along x only', solid(box(10, [5, 0, 0]))],
      ['a thin slab inside, flush with one face', solid(box([10, 10, 1]))],
    ];
    for (const [label, other] of cases) {
      const forward = meshInterference(cube, other);
      assert.equal(forward.interferes, true, label);
      assert.equal(forward.crossingPairs, 0, label);
      assert.equal(meshInterference(other, cube).interferes, true, `${label}, reversed`);
    }
    assert.equal(meshInterference(cube, solid(box(10, [5, 0, 0]))).reason, 'volumes_overlap');
    // Offset on two axes, the side faces cross along the shared top and
    // bottom planes' edges; either way it is a clash.
    assert.equal(meshInterference(cube, solid(box(10, [5, 5, 0]))).interferes, true);
    // Winding does not matter: an inside-out copy still overlaps.
    assert.equal(meshInterference(cube, solid(inverted(box(10)))).interferes, true);
  });

  test('aligned parts that only share a face, or a strip of one, still do not interfere', () => {
    const cube = solid(box(10));
    assert.equal(meshInterference(cube, solid(box(10, [10, 0, 0]))).interferes, false);
    assert.equal(meshInterference(cube, solid(box(10, [10, 5, 0]))).interferes, false);
    assert.equal(meshInterference(cube, solid(box([10, 10, 5], [0, 0, 10]))).interferes, false);
  });

  test('parts far apart are rejected by their bounding boxes alone', () => {
    const result = meshInterference(solid(box(10)), solid(box(10, [100, 0, 0])));
    assert.equal(result.interferes, false);
    assert.equal(result.boundingBoxesOverlap, false);
    assert.equal(result.pairsTested, 0);
  });

  test('a peg through a plate interferes; the same peg in a clearance hole does not', () => {
    const plate = solid(bracket());
    // Hole 1 spans x 5..10, y 5..10, z 0..5. A 3 mm peg centred in it clears;
    // a 7 mm peg there cuts the plate.
    assert.equal(meshInterference(plate, solid(box([3, 3, 15], [6, 6, -5]))).interferes, false);
    assert.equal(meshInterference(plate, solid(box([7, 7, 15], [4, 4, -5]))).interferes, true);
  });

  test('triangle primitives: crossing, coplanar and touching', () => {
    const a = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
    assert.equal(trianglesCross(a, [[2, 2, -1], [2, 2, 1], [8, 0.5, 0.5]], 1e-9), true);
    assert.equal(trianglesCross(a, [[1, 1, 0], [5, 1, 0], [1, 5, 0]], 1e-9), false, 'coplanar overlap is contact');
    assert.equal(trianglesCross(a, [[2, 2, 0], [2, 2, 5], [6, 2, 5]], 1e-9), false, 'a vertex resting on the face');
    assert.ok(pointInsideMesh([5, 5, 5], box(10)));
    assert.ok(!pointInsideMesh([15, 5, 5], box(10)));
  });

  test('point-in-mesh is not fooled by rays that run through grid edges', () => {
    // From grid points, rays along small-integer directions pass exactly
    // through the plate's quad diagonals and cell corners, where a crossing
    // is counted twice or not at all.
    const plate = bracket();
    assert.ok(pointInsideMesh([2, 2, 2], plate), 'solid material');
    assert.ok(pointInsideMesh([12.5, 2.5, 2.5], plate), 'solid material');
    assert.ok(!pointInsideMesh([7.5, 7.5, 2.5], plate), 'the centre of a hole');
    for (const x of [6.5, 7.5, 8.5]) for (const y of [6.5, 7.5, 8.5]) assert.ok(!pointInsideMesh([x, y, 2.5], plate), `hole point ${x},${y}`);
  });

  test('the grid prefilter finds the crossings a brute-force check finds', () => {
    // Two tiled plates, one offset by 1 mm on every axis: many triangles,
    // crossings only along the overlap.
    const cells = [];
    for (let i = 0; i < 10; i += 1) for (let j = 0; j < 10; j += 1) cells.push(`${i},${j}`);
    const flat = extrudeCells(cells, { cell: 2, height: 2 });
    const offset = extrudeCells(cells, { cell: 2, height: 2, origin: [-1, -1, -1] });
    const result = meshInterference(solid(flat), solid(offset));
    let brute = 0;
    const tri = (t, i) => [[t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]]];
    for (let i = 0; i < flat.length; i += 9) for (let j = 0; j < offset.length; j += 9) if (trianglesCross(tri(flat, i), tri(offset, j), result.tolerance)) brute += 1;
    assert.equal(result.crossingPairs, brute);
    assert.ok(brute > 0);
  });
});

describe('STEP product structure', () => {
  test('the assembly fixture: one assembly using a bracket once and a bolt twice', () => {
    const structure = readStep(fixture('bracket-assembly.step'));
    assert.equal(structure.lengthUnit, 'mm');
    assert.equal(structure.header.fileName, 'bracket-assembly.step');
    assert.deepEqual(structure.header.schemas, ['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }']);
    const byId = Object.fromEntries(structure.products.map((p) => [p.id, p]));
    assert.equal(byId['ASM-1'].kind, 'assembly');
    assert.equal(byId['ASM-1'].root, true);
    assert.equal(byId['ASM-1'].description, "A bracket bolted down; it's the root", 'doubled quotes unescape');
    assert.deepEqual(byId['ASM-1'].contains, [{ id: 'BRK-1', name: 'Bracket', quantity: 1 }, { id: 'BLT-M4', name: 'M4 bolt', quantity: 2 }]);
    assert.equal(byId['BRK-1'].kind, 'part');
    assert.equal(byId['BLT-M4'].root, false);
    assert.equal(structure.counts.solids, 0);
  });

  test('an OCCT-exported solid: one part, one solid, six faces, millimetres', () => {
    const structure = readStep(fixture('cube.step'));
    assert.equal(structure.products.length, 1);
    assert.equal(structure.products[0].kind, 'part');
    assert.equal(structure.counts.solids, 1);
    assert.equal(structure.counts.faces, 6);
    assert.equal(structure.lengthUnit, 'mm');
    assert.match(structure.header.originatingSystem, /Open CASCADE/);
  });

  test('inch units are recognised', () => {
    const text = fixture('bracket-assembly.step').toString().replace(
      '#50=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));',
      "#50=(CONVERSION_BASED_UNIT('INCH',#53)LENGTH_UNIT()NAMED_UNIT(#54));"
    );
    assert.equal(readStep(Buffer.from(text)).lengthUnit, 'in');
  });

  test('a semicolon or comment inside a string does not split a record', () => {
    const text = fixture('bracket-assembly.step').toString().replace("'Mounting bracket'", "'Mounting; bracket /* not a comment */'");
    const byId = Object.fromEntries(readStep(Buffer.from(text)).products.map((p) => [p.id, p]));
    assert.equal(byId['BRK-1'].description, 'Mounting; bracket /* not a comment */');
  });

  test('refuses files that are not STEP or are cut short', () => {
    assert.throws(() => parseStep(Buffer.from('solid x')), (err) => err.code === 'invalid_step');
    assert.throws(() => parseStep(Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=PRODUCT('a','b',;\n")), (err) => err.code === 'invalid_step');
    assert.throws(() => parseStep(Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n')), /no DATA/);
    assert.throws(() => parseStep(Buffer.from("ISO-10303-21;\nDATA;\n#1=PRODUCT('a /* unterminated';\n")), (err) => err.code === 'invalid_step');
  });

  test('refuses an unterminated binary value or runaway nesting as invalid STEP, not a stack overflow', () => {
    const data = (entity) => Buffer.from(`ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${entity};\nENDSEC;\nEND-ISO-10303-21;\n`);
    for (const entity of ['#1=PRODUCT("0AB', `#1=PRODUCT(${'('.repeat(50_000)}`, `#1=PRODUCT(${'X('.repeat(50_000)}`]) {
      assert.throws(() => readStep(data(entity)), (err) => err.code === 'invalid_step' && !(err instanceof RangeError), entity.slice(0, 20));
    }
    // Ordinary nesting still reads.
    assert.doesNotThrow(() => parseStep(data(`#1=PRODUCT(${'('.repeat(10)}1${')'.repeat(10)})`)));
  });
});

describe('units', () => {
  test('lengths and densities convert, and unknown units are refused', () => {
    assert.equal(lengthUnit('millimetres'), 'mm');
    assert.equal(convertLength(1, 'in', 'mm'), 25.4);
    assert.equal(densityToSi({ value: 2.7, unit: 'g/cm³' }).kgPerM3, 2700);
    assert.throws(() => lengthUnit('furlong'), (err) => err.code === 'invalid_units');
    assert.throws(() => densityToSi({ value: 1, unit: 'stone/pint' }), (err) => err.code === 'invalid_units');
    assert.throws(() => densityToSi({ value: -1, unit: 'kg/m3' }), (err) => err.code === 'invalid_input');
    assert.throws(() => densityToSi(7800), (err) => err.code === 'invalid_input');
  });
});

describe('fixture shapes', () => {
  test('withoutFace removes exactly the two triangles of that face', () => {
    assert.equal(withoutFace(box(10), 2, 10).length, 10 * 9);
  });
});
