import { constants, realpathSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { CodeError, resolveInside } from '../code/paths.js';
import { CadError } from './errors.js';
import { MAX_STEP_BYTES } from './step.js';
import { MAX_STL_BYTES } from './stl.js';
import { densityToSi, lengthUnit } from './units.js';

// Where a capability finds the project's CAD files, and what the project
// declares about them in `cad.json` at its root:
//
//   {
//     "units": "mm",                                  // what STL coordinates mean
//     "density": { "value": 2700, "unit": "kg/m3" },  // default for mass properties
//     "assembly": ["base.stl", "lid.stl"],            // parts that must not interfere
//     "dimensions": [                                 // checks cad.dimensions applies
//       { "file": "bracket.stl", "measure": "holes.spacing", "value": 50, "tolerance": 0.1 }
//     ]
//   }
//
// Every field is optional; a project without the file is in millimetres.

export const CONFIG_FILE = 'cad.json';
const MAX_CONFIG_BYTES = 256 * 1024;
export const OUTPUT_DIR = 'cad-out';

export const FORMATS = { '.stl': 'stl', '.step': 'step', '.stp': 'step' };

export function formatOf(path) {
  return FORMATS[extname(path).toLowerCase()] ?? null;
}

function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// The directories a capability reads from, in order: the run's sandbox copy
// when it has one (so a read after an edit sees the edit); in a run with
// only a scratch sandbox, the parts its edits produced and then the user's
// checkout; otherwise the checkout.
export function cadRoots(ctx) {
  const roots = [];
  if (ctx?.sandbox?.worktree) roots.push(ctx.sandbox.worktree);
  else {
    if (ctx?.sandbox?.scratch) roots.push(join(ctx.sandbox.scratch, OUTPUT_DIR));
    if (ctx?.localPath) roots.push(ctx.localPath);
  }
  const real = roots.map(realOrNull).filter(Boolean);
  if (real.length === 0) throw new CadError('no_checkout', 'the project has no local files to work on');
  return real;
}

// Resolves a project-relative path in the first root that has it. Paths
// may not leave the project or reach into its git directory.
export async function resolveCadFile(ctx, path) {
  const roots = cadRoots(ctx);
  let firstError = null;
  for (const root of roots) {
    try {
      const { abs, rel } = resolveInside(root, path);
      const stat = await lstat(abs).catch(() => null);
      if (stat?.isFile()) return { abs, rel, root };
      if (stat) throw new CadError('not_a_file', `${rel} is not a regular file`);
    } catch (err) {
      if (!(err instanceof CodeError) && !(err instanceof CadError)) throw err;
      firstError ??= err;
    }
  }
  if (firstError && firstError.code !== 'not_found') throw new CadError(firstError.code, firstError.message);
  throw new CadError('not_found', `${path} does not exist in the project`);
}

export async function readCadFile(ctx, path) {
  if (typeof path !== 'string' || !path) throw new CadError('invalid_input', 'path must be a project-relative file path');
  const format = formatOf(path);
  if (!format) throw new CadError('unsupported_format', `${path} is not an STL or STEP file`);
  const file = await resolveCadFile(ctx, path);
  const limit = format === 'stl' ? MAX_STL_BYTES : MAX_STEP_BYTES;
  // O_NOFOLLOW: a link swapped in after the path check is refused, not read.
  const handle = await open(file.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.size > limit) throw new CadError('file_too_large', `${file.rel} is larger than ${limit} bytes`);
    return { ...file, format, buffer: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

function validateConfig(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new CadError('invalid_config', `${CONFIG_FILE} must hold a JSON object`);
  const config = { units: 'mm', density: null, assembly: [], dimensions: [] };
  if (raw.units != null) config.units = lengthUnit(raw.units, { label: `${CONFIG_FILE} units` });
  if (raw.density != null) {
    densityToSi(raw.density);
    config.density = raw.density;
  }
  if (raw.assembly != null) {
    if (!Array.isArray(raw.assembly) || !raw.assembly.every((p) => typeof p === 'string' && p)) throw new CadError('invalid_config', `${CONFIG_FILE} assembly must be a list of paths`);
    config.assembly = raw.assembly;
  }
  if (raw.dimensions != null) {
    if (!Array.isArray(raw.dimensions)) throw new CadError('invalid_config', `${CONFIG_FILE} dimensions must be a list`);
    config.dimensions = raw.dimensions;
  }
  return config;
}

// The project's declarations. A missing file is the defaults; a malformed
// one is an error, since silently ignoring it would check the wrong thing.
export async function projectConfig(ctx) {
  let root;
  try {
    root = cadRoots(ctx).at(-1);
  } catch {
    return validateConfig({});
  }
  // The sandbox copy's own cad.json wins, so the config a run sees matches
  // the files it sees.
  const where = ctx?.sandbox?.worktree ? realOrNull(ctx.sandbox.worktree) : root;
  let text;
  try {
    const { abs } = resolveInside(where, CONFIG_FILE);
    const stat = await lstat(abs).catch(() => null);
    if (!stat) return validateConfig({});
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new CadError('invalid_config', `${CONFIG_FILE} must be a small regular file`);
    text = await readFile(abs, 'utf8');
  } catch (err) {
    if (err instanceof CadError) throw err;
    throw new CadError('invalid_config', `${CONFIG_FILE} could not be read: ${err.message}`);
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch (err) {
    if (err instanceof CadError) throw err;
    throw new CadError('invalid_config', `${CONFIG_FILE} is not valid JSON`);
  }
}
