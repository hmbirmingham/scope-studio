// Writes the CAD fixtures in this directory. Run with
// `node test/fixtures/cad/generate.mjs` from server/; the output is
// deterministic, so re-running it changes nothing unless a shape changes.
// The STEP solids (cube.step, two-boxes.step) come from generate_step.py,
// which needs CadQuery.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAsciiStl, encodeBinaryStl } from '../../../src/plugins/cad/stl.js';
import { assemblyStep, box, bracket, withoutFace } from './shapes.js';

const here = dirname(fileURLToPath(import.meta.url));
const write = (name, data) => writeFileSync(join(here, name), data);

write('cube.stl', encodeBinaryStl(box(10), { name: 'cube 10 mm' }));
write('cube-ascii.stl', encodeAsciiStl(box(10), { name: 'cube' }));
write('bracket.stl', encodeBinaryStl(bracket(), { name: 'bracket 60x20x5 mm, holes 40 mm apart' }));
write('overlap-a.stl', encodeBinaryStl(box(10), { name: 'overlap a' }));
write('overlap-b.stl', encodeBinaryStl(box(10, [5, 5, 5]), { name: 'overlap b' }));
write('touching.stl', encodeBinaryStl(box(10, [10, 0, 0]), { name: 'touching a' }));
write('inner.stl', encodeBinaryStl(box(2, [4, 4, 4]), { name: 'inside a' }));
write('open-box.stl', encodeAsciiStl(withoutFace(box(10), 2, 10), { name: 'open box' }));
write('bracket-assembly.step', assemblyStep());
