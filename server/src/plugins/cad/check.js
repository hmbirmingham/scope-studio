import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { CodeError, resolveInside } from '../code/paths.js';
import { CadError } from './errors.js';
import { describeChecks, evaluateChecks, validateChecks } from './measure.js';
import { analyseMesh, geometryProblems } from './mesh.js';
import { MAX_STL_BYTES, parseStl } from './stl.js';

// The objective check for a CAD task (the task benchmark): the part a run
// left behind is measured against the task's own dimension checks. It only
// reads the file and measures it in JavaScript; nothing in the result is
// executed, so it needs neither CadQuery nor the OS sandbox. A missing,
// unreadable or broken part is simply not completed.

export async function checkCadResult({ dir, check }) {
  const checks = validateChecks(check.dimensions, 'check.dimensions');
  try {
    const root = dir ? await realpath(dir).catch(() => null) : null;
    if (!root) throw new CadError('not_found', 'the run left no files to check');
    const { abs, rel } = resolveInside(root, check.file);
    const stat = await lstat(abs).catch(() => null);
    if (!stat?.isFile()) throw new CadError('not_found', `${rel} is missing`);
    if (stat.size > MAX_STL_BYTES) throw new CadError('file_too_large', `${rel} is too large`);
    const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    let buffer;
    try {
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
    const { triangles } = parseStl(buffer);
    const analysis = analyseMesh(triangles);
    const problems = geometryProblems(analysis);
    const results = evaluateChecks(triangles, checks, { analysis, units: check.units ?? 'mm' });
    const completed = problems.length === 0 && results.every((r) => r.ok);
    const lines = [`${rel}: ${problems.length ? problems.join('; ') : 'valid solid'}`, describeChecks(results)];
    return { completed, results, output: lines.join('\n') };
  } catch (err) {
    if (!(err instanceof CadError) && !(err instanceof CodeError)) throw err;
    return { completed: false, results: [], output: `${err.code}: ${err.message}` };
  }
}
