import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { TASKS, fixturePath } from '../../src/benchmark/tasks/catalog.js';
import { checkCadResult } from '../../src/plugins/cad/check.js';
import { encodeBinaryStl } from '../../src/plugins/cad/stl.js';
import { withoutFace, box, bracket } from '../fixtures/cad/shapes.js';
import { removeTempDirs, tempDir } from '../integration/workspaceSandboxFixtures.js';

// The CAD task's objective check: the part a run leaves is measured against
// the task's dimensions, and anything missing, broken or off is not done.

const task = TASKS.find((entry) => entry.id === 'cad-bracket-hole-spacing');
after(removeTempDirs);

function result(files) {
  const dir = tempDir('cad-check');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('the CAD task check', () => {
  test('the untouched fixture is not completed: its holes are 40 mm apart', async () => {
    const verdict = await checkCadResult({ dir: fixturePath(task), check: task.check });
    assert.equal(verdict.completed, false);
    assert.match(verdict.output, /FAIL holes\.spacing: (40|39\.99)/);
    assert.match(verdict.output, /pass holes\.minWall: 7\.5/);
  });

  test('a part with the holes in the wrong place, or too close to the edge, is not completed', async () => {
    // The grid bracket: 60 mm long, holes 40 mm apart with 5 mm walls.
    const verdict = await checkCadResult({ dir: result({ 'bracket.stl': encodeBinaryStl(bracket()) }), check: task.check });
    assert.equal(verdict.completed, false);
    assert.match(verdict.output, /FAIL size\.x: 60/);
    const custom = { ...task.check, dimensions: [{ measure: 'holes.spacing', value: 40, tolerance: 0.1 }, { measure: 'holes.minWall', min: 6 }] };
    const thin = await checkCadResult({ dir: result({ 'bracket.stl': encodeBinaryStl(bracket()) }), check: custom });
    assert.equal(thin.completed, false);
    assert.match(thin.output, /FAIL holes\.minWall: 5/);
  });

  test('a part that measures right but is not a closed solid is not completed', async () => {
    const check = { ...task.check, dimensions: [{ measure: 'size.x', value: 10, tolerance: 0.01 }] };
    const open = await checkCadResult({ dir: result({ 'bracket.stl': encodeBinaryStl(withoutFace(box(10), 2, 10)) }), check });
    assert.equal(open.completed, false);
    assert.match(open.output, /not watertight/);
    const closed = await checkCadResult({ dir: result({ 'bracket.stl': encodeBinaryStl(box(10)) }), check });
    assert.equal(closed.completed, true);
  });

  test('a missing, unreadable or linked part is not completed, and never read through the link', async () => {
    assert.equal((await checkCadResult({ dir: null, check: task.check })).completed, false);
    assert.match((await checkCadResult({ dir: result({ 'other.stl': encodeBinaryStl(box(1)) }), check: task.check })).output, /^not_found/);
    assert.match((await checkCadResult({ dir: result({ 'bracket.stl': 'solid nonsense\nfacet' }), check: task.check })).output, /^invalid_stl/);
    const outside = result({ 'real.stl': encodeBinaryStl(box(10)) });
    const linked = result({});
    symlinkSync(join(outside, 'real.stl'), join(linked, 'bracket.stl'));
    assert.match((await checkCadResult({ dir: linked, check: task.check })).output, /^path_escapes/);
  });
});
