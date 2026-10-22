import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { getPool } from '../../db/pool.js';
import { tryEmbedDocument } from '../../lib/embeddings.js';
import { ensureRelationship, upsertNodeByExternalId } from '../../models/nodeStore.js';
import { defaultCadQuery } from './cadquery.js';
import { CadError } from './errors.js';
import { analyseMesh, geometryProblems } from './mesh.js';
import { formatOf, projectConfig } from './project.js';
import { MAX_STEP_BYTES, readStep } from './step.js';
import { MAX_STL_BYTES, parseStl } from './stl.js';

// CAD ingest: every STL and STEP file in a project's local folder becomes
// graph nodes, so conversations and agents can find parts by what they are.
// An STL is one `part`; a STEP file is its products, `assembly` or `part`,
// with `contains` edges from each assembly to what it uses (weighted by how
// many times). Nodes carry stable external ids (the project, the file's
// path and, for STEP, the product id), so ingesting again updates rather
// than duplicates, and nodes for files that are gone are removed. External
// ids are unique per owner and source, so the project is part of them: two
// projects may both have a cube.stl. Nothing here needs the
// network; STEP geometry is added when CadQuery is available, from the
// sandbox like every other CadQuery call.

export const SOURCE = 'cad';
const MAX_FILES = 500;
const MAX_DEPTH = 12;
const SKIP_DIRS = new Set(['node_modules', '__pycache__']);

// The files to ingest. Symlinks are never followed (a link could lead out
// of the project), nor are hidden directories or dependency folders.
export async function findCadFiles(root) {
  const base = await realpath(root);
  const found = [];
  let truncated = false;
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path, depth + 1);
      } else if (entry.isFile() && formatOf(entry.name)) {
        if (found.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        found.push({ abs: path, rel: relative(base, path).split(sep).join('/') });
      }
    }
  }
  await walk(base, 0);
  return { base, files: found, truncated };
}

async function readLimited(abs, limit) {
  const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.size > limit) throw new CadError('file_too_large', `larger than ${limit} bytes`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

const fmt = (value) => (value == null ? '?' : String(Number(Number(value).toPrecision(6))));

function stlContent(rel, mesh, analysis, units) {
  const problems = geometryProblems(analysis);
  return [
    `Part ${rel} (STL, ${mesh.format}${mesh.name ? `, "${mesh.name}"` : ''})`,
    `Units: ${units}`,
    `Bounding box: ${analysis.boundingBox.size.map(fmt).join(' × ')} ${units}`,
    `Volume: ${fmt(analysis.volume)} ${units}³; surface area: ${fmt(analysis.surfaceArea)} ${units}²`,
    `Centroid: (${(analysis.centroid ?? []).map(fmt).join(', ')}) ${units}`,
    `Mesh: ${analysis.triangles} triangles, ${analysis.watertight ? 'watertight' : 'not watertight'}`,
    problems.length ? `Problems: ${problems.join('; ')}` : 'Problems: none',
  ].join('\n');
}

function stepContent(rel, product, structure, geometry) {
  const lines = [
    `${product.kind === 'assembly' ? 'Assembly' : 'Part'} ${product.name} (${product.id}) from ${rel} (STEP)`,
  ];
  if (product.description) lines.push(`Description: ${product.description}`);
  if (product.contains.length) lines.push(`Contains: ${product.contains.map((c) => `${c.quantity} × ${c.name}`).join(', ')}`);
  if (structure.lengthUnit) lines.push(`File units: ${structure.lengthUnit}`);
  if (structure.header.originatingSystem) lines.push(`Authored in: ${structure.header.originatingSystem}`);
  if (geometry) {
    lines.push(
      `Geometry: ${geometry.solids} solid(s), ${geometry.valid ? 'valid' : 'invalid'} B-rep, volume ${fmt(geometry.volume)} mm³, ` +
        `bounding box ${geometry.boundingBox.size.map(fmt).join(' × ')} mm`
    );
  }
  return lines.join('\n');
}

export function externalId(project, rel, productId = null) {
  return `${project}|${rel}${productId == null ? '' : `#${productId}`}`;
}

// An upsert keeps the node's original type and privacy. A product that
// became an assembly (or stopped being one) is corrected here, and so is the
// privacy: ingesting a project as local must make its nodes local again.
async function settle(nodeId, type, privacy) {
  await getPool().query('UPDATE nodes SET type = $2, privacy = $3 WHERE id = $1 AND (type <> $2 OR privacy <> $3)', [nodeId, type, privacy]);
}

export async function ingestCadProject({ ownerId, project, localPath, privacy = 'local', cadquery = defaultCadQuery, onProgress, embed = tryEmbedDocument }) {
  if (!['local', 'cloud'].includes(privacy)) throw new CadError('invalid_input', 'privacy must be local or cloud');
  const config = await projectConfig({ localPath });
  const { files, truncated } = await findCadFiles(localPath);
  const summary = { files: files.length, parts: 0, assemblies: 0, relationships: 0, skipped: [], pruned: 0, truncated, geometry: 'not needed' };
  const written = [];
  const failed = [];

  let cadqueryState = null;
  const geometryFor = async (rel, buffer) => {
    cadqueryState ??= await cadquery.status().catch((err) => ({ available: false, reason: err.message }));
    summary.geometry = cadqueryState.available ? 'CadQuery' : `unavailable (${cadqueryState.reason})`;
    if (!cadqueryState.available) return null;
    try {
      const [info] = await cadquery.inspect([{ name: rel, buffer }]);
      return info;
    } catch {
      return null;
    }
  };

  const upsert = async ({ type, content, id }) => {
    const node = await upsertNodeByExternalId({ ownerId, type, content, source: SOURCE, externalId: id, project, privacy, embedding: await embed(content) });
    await settle(node.id, type, privacy);
    written.push(id);
    if (type === 'assembly') summary.assemblies += 1;
    else summary.parts += 1;
    return node;
  };

  for (const [index, file] of files.entries()) {
    onProgress?.({ file: file.rel, filesDone: index, filesTotal: files.length });
    try {
      if (formatOf(file.rel) === 'stl') {
        const mesh = parseStl(await readLimited(file.abs, MAX_STL_BYTES));
        const analysis = analyseMesh(mesh.triangles);
        await upsert({ type: 'part', content: stlContent(file.rel, mesh, analysis, config.units), id: externalId(project, file.rel) });
      } else {
        const buffer = await readLimited(file.abs, MAX_STEP_BYTES);
        const structure = readStep(buffer);
        // Geometry is of the whole file, so it describes the product only
        // when the file holds a single one (a part file).
        const geometry = structure.products.length === 1 && structure.counts.solids > 0 ? await geometryFor(file.rel, buffer) : null;
        const nodes = new Map();
        for (const product of structure.products) {
          const node = await upsert({ type: product.kind, content: stepContent(file.rel, product, structure, geometry), id: externalId(project, file.rel, product.id) });
          nodes.set(product.id, node);
        }
        for (const product of structure.products) {
          for (const child of product.contains) {
            await ensureRelationship(ownerId, { sourceId: nodes.get(product.id).id, targetId: nodes.get(child.id).id, type: 'contains', weight: child.quantity });
            summary.relationships += 1;
          }
        }
      }
    } catch (err) {
      // One unreadable file does not stop the rest; its old nodes are kept.
      failed.push(externalId(project, file.rel));
      summary.skipped.push({ path: file.rel, error: String(err.message).slice(0, 300) });
    }
  }
  onProgress?.({ file: null, filesDone: files.length, filesTotal: files.length });

  // Files that are gone take their nodes with them. A truncated walk did not
  // see every file, so it removes nothing.
  if (!truncated) {
    const { rowCount } = await getPool().query(
      `DELETE FROM nodes
       WHERE owner_id = $1 AND source = $2 AND project IS NOT DISTINCT FROM $3
         AND external_id IS NOT NULL
         AND NOT (external_id = ANY($4::text[]))
         AND NOT EXISTS (SELECT 1 FROM unnest($5::text[]) AS f(path) WHERE external_id = f.path OR starts_with(external_id, f.path || '#'))`,
      [ownerId, SOURCE, project, written, failed]
    );
    summary.pruned = rowCount;
  }
  return summary;
}

export async function isDirectory(path) {
  const stat = await lstat(path).catch(() => null);
  return Boolean(stat?.isDirectory());
}
