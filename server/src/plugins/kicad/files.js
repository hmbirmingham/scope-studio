import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveInside } from '../code/paths.js';
import { parseBoard } from './board.js';
import { parseSchematicFile, resolveDesign, resolveRelative } from './schematic.js';
import { KicadError } from './sexpr.js';

// Finding and reading a project's KiCad files. Every path is relative to the
// project folder and must stay inside it (the code plug-in's resolveInside:
// no absolute paths, no `..`, no symlink that leads out), so a sheet that
// names "../../etc/passwd" as its file is refused rather than read.

export const MAX_DESIGN_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.history', '__pycache__', '.venv', 'venv']);
export const KICAD_EXTENSIONS = ['.kicad_sch', '.kicad_pcb', '.kicad_pro'];

// KiCad project files under `root`, as sorted relative paths. Symlinks are
// not followed and KiCad's automatic backup folders are skipped.
export async function listKicadFiles(root, { maxFiles = MAX_FILES, maxDepth = MAX_DEPTH } = {}) {
  const found = [];
  let truncated = false;
  const walk = async (dir, rel, depth) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= maxFiles) {
        truncated = true;
        return;
      }
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(entry.name) || entry.name.endsWith('-backups') || entry.name.startsWith('.')) continue;
        await walk(join(dir, entry.name), relPath, depth + 1);
      } else if (entry.isFile() && KICAD_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && !entry.name.startsWith('_autosave-')) {
        found.push(relPath);
      }
    }
  };
  await walk(root, '', 0);
  return { files: found, truncated };
}

export async function readDesignFile(root, relPath) {
  const { abs, rel } = resolveInside(root, relPath);
  const stat = await lstat(abs).catch(() => null);
  if (!stat) throw new KicadError('not_found', `${rel} does not exist`);
  if (!stat.isFile()) throw new KicadError('not_a_file', `${rel} is not a regular file`);
  if (stat.size > MAX_DESIGN_BYTES) throw new KicadError('file_too_large', `${rel} is larger than ${MAX_DESIGN_BYTES} bytes`);
  return { rel, text: await readFile(abs, 'utf8') };
}

function requireExtension(relPath, ext) {
  if (typeof relPath !== 'string' || !relPath.endsWith(ext)) {
    throw new KicadError('invalid_input', `${relPath} is not a ${ext} file`);
  }
}

// Parses a root schematic and every sheet it uses (missing sheets are
// reported on the design, not fatal), then resolves its nets.
export async function loadSchematic(root, relPath, { cache = new Map() } = {}) {
  requireExtension(relPath, '.kicad_sch');
  const files = new Map();
  const pending = [relPath];
  let rootRel = null;
  while (pending.length > 0) {
    const next = pending.shift();
    if (files.has(next)) continue;
    let parsed = cache.get(next);
    if (!parsed) {
      let file;
      try {
        file = await readDesignFile(root, next);
      } catch (err) {
        // The root must exist; a missing sub-sheet is only reported.
        if (next === relPath) throw err;
        continue;
      }
      parsed = { rel: file.rel, sheet: parseSchematicFile(file.text) };
      cache.set(next, parsed);
    }
    if (next === relPath) rootRel = parsed.rel;
    files.set(parsed.rel, parsed.sheet);
    for (const sheet of parsed.sheet.sheets) {
      if (sheet.file) pending.push(resolveRelative(parsed.rel, sheet.file));
    }
    if (files.size > 200) throw new KicadError('design_too_large', 'the design uses more than 200 sheet files');
  }
  return resolveDesign(files, rootRel);
}

export async function loadBoard(root, relPath) {
  requireExtension(relPath, '.kicad_pcb');
  const file = await readDesignFile(root, relPath);
  return { path: file.rel, ...parseBoard(file.text) };
}

// The schematics no other schematic uses as a sheet: the designs' roots.
export async function rootSchematics(root, schematics) {
  const used = new Set();
  for (const rel of schematics) {
    try {
      const { sheets } = parseSchematicFile((await readDesignFile(root, rel)).text);
      for (const sheet of sheets) if (sheet.file) used.add(resolveRelative(rel, sheet.file));
    } catch {
      // An unreadable file is reported when it is loaded as a design.
    }
  }
  return schematics.filter((rel) => !used.has(rel));
}

// Which design file a capability works on: the one the input names, else
// the only candidate, else the one that shares its name with a .kicad_pro.
export async function chooseDesign(root, { requested, ext }) {
  if (requested != null) {
    requireExtension(requested, ext);
    return resolveInside(root, requested).rel;
  }
  const { files } = await listKicadFiles(root);
  let candidates = files.filter((rel) => rel.endsWith(ext));
  if (ext === '.kicad_sch') candidates = await rootSchematics(root, candidates);
  if (candidates.length === 1) return candidates[0];
  const projects = new Set(files.filter((rel) => rel.endsWith('.kicad_pro')).map((rel) => rel.slice(0, -'.kicad_pro'.length)));
  const matching = candidates.filter((rel) => projects.has(rel.slice(0, -ext.length)));
  if (matching.length === 1) return matching[0];
  if (candidates.length === 0) throw new KicadError('no_design', `the project has no ${ext} file`);
  throw new KicadError('ambiguous_design', `the project has several ${ext} files; name one of: ${candidates.slice(0, 20).join(', ')}`, { candidates });
}
