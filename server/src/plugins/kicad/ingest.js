import { realpath, stat } from 'node:fs/promises';
import { getPool } from '../../db/pool.js';
import { tryEmbedDocuments } from '../../lib/embeddings.js';
import { billOfMaterials, compareRefs } from './schematic.js';
import { listKicadFiles, loadBoard, loadSchematic, rootSchematics } from './files.js';
import { KicadError } from './sexpr.js';

// KiCad ingest: a project's local folder becomes graph nodes in the shared
// vocabulary (migration 039): schematic, symbol, net and bom_row from each
// root schematic; board, footprint and net from each board. Nets `connect`
// the symbols (or footprints) on them, a footprint `implements` its symbol,
// and everything is `part_of` its schematic or board.
//
// Re-ingest is idempotent: every node has a stable external id, so a second
// run updates in place (node ids, and the agent notes linked to them,
// survive), removes what is no longer in the files and rebuilds the links,
// all in one transaction. Nothing here touches the network except the local
// embedding model, and ingest does not fail when that is down.

export const SOURCE = 'kicad';
const EMBED_BATCH = 32;
const MAX_CONTENT = 4000;
const MAX_LISTED = 64;
const STRUCTURAL = ['part_of', 'connects', 'implements'];

export function externalId(project, kind, file, name = null) {
  return [encodeURIComponent(project), kind, file, ...(name == null ? [] : [name])].join('|');
}

// A BOM line is named by what groups it. Postgres text cannot hold a NUL,
// so the two parts are joined with the external id's own separator.
export const bomRowName = (row) => `${row.value}|${row.footprint}`;

function clip(text) {
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text;
}

function listed(items, render = String) {
  const shown = items.slice(0, MAX_LISTED).map(render).join(', ');
  return items.length > MAX_LISTED ? `${shown}, … and ${items.length - MAX_LISTED} more` : shown;
}

const pinRef = (pin) => `${pin.reference}.${pin.number}${pin.name && pin.name !== '~' && pin.name !== pin.number ? ` (${pin.name})` : ''}`;

export function schematicContent(rel, design, bom) {
  const lines = [`KiCad schematic ${rel}${design.title ? ` — ${design.title}` : ''}${design.revision ? ` (rev ${design.revision})` : ''}`];
  lines.push(`${design.symbols.length} parts, ${design.nets.length} nets, ${bom.length} BOM lines.`);
  const power = design.nets.filter((net) => net.power).map((net) => net.name);
  if (power.length) lines.push(`Power nets: ${listed(power)}.`);
  if (design.files.length > 1) lines.push(`Sheets: ${listed(design.files)}.`);
  if (design.missingSheets.length) lines.push(`Missing sheets: ${listed(design.missingSheets)}.`);
  return clip(lines.join('\n'));
}

export function symbolContent(rel, symbol) {
  const lines = [`Symbol ${symbol.reference}: ${symbol.value || '(no value)'} — ${symbol.libId} in ${rel}`];
  lines.push(`Footprint: ${symbol.footprint || '(none)'}`);
  if (symbol.description) lines.push(`Description: ${symbol.description}`);
  if (symbol.datasheet) lines.push(`Datasheet: ${symbol.datasheet}`);
  for (const [name, value] of Object.entries(symbol.fields)) if (value) lines.push(`${name}: ${value}`);
  if (symbol.dnp) lines.push('Do not populate.');
  if (symbol.pins.length) lines.push(`Pins: ${listed(symbol.pins, (pin) => `${pin.number}${pin.name && pin.name !== '~' && pin.name !== pin.number ? ` ${pin.name}` : ''} → ${pin.net ?? 'unconnected'}`)}`);
  return clip(lines.join('\n'));
}

export function netContent(rel, net) {
  const kind = net.ground ? 'ground net' : net.power ? 'power net' : 'net';
  const lines = [`Schematic ${kind} ${net.name} in ${rel}`];
  if (net.aliases.length) lines.push(`Also labelled: ${listed(net.aliases)}`);
  lines.push(`Pins: ${listed(net.pins, pinRef)}`);
  return clip(lines.join('\n'));
}

export function bomContent(rel, row) {
  return clip(`BOM line in ${rel}: ${row.quantity} × ${row.value || '(no value)'}, footprint ${row.footprint || '(none)'} — ${listed(row.references)} (${row.libIds.join(', ')})`);
}

export function boardContent(rel, board) {
  return clip([
    `KiCad board ${rel}${board.title ? ` — ${board.title}` : ''}`,
    `${board.footprints.length} footprints, ${board.nets.length} nets, copper layers ${board.copperLayers.join(', ') || 'unknown'}${board.thickness ? `, ${board.thickness} mm thick` : ''}.`,
  ].join('\n'));
}

export function footprintContent(rel, footprint) {
  const pads = footprint.pads.filter((pad) => pad.number);
  return clip([
    `Footprint ${footprint.reference}: ${footprint.value || '(no value)'} — ${footprint.footprint} on ${footprint.layer} at (${footprint.x}, ${footprint.y}) ${footprint.angle}° in ${rel}`,
    pads.length ? `Pads: ${listed(pads, (pad) => `${pad.number} → ${pad.net ?? 'no net'}`)}` : 'No pads.',
  ].join('\n'));
}

export function boardNetContent(rel, net) {
  return clip(`Board net ${net.name} in ${rel}: ${listed(net.pads, (pad) => `${pad.reference}.${pad.pad}`)}`);
}

// The nodes and links for one project folder, before anything is written.
export async function buildProjectGraph({ root, project }) {
  const { files, truncated } = await listKicadFiles(root);
  const nodes = new Map(); // externalId → { type, content }
  const links = []; // { from, to, type } by external id
  const errors = [];
  const counts = { schematics: 0, boards: 0, symbols: 0, nets: 0, bomRows: 0, footprints: 0, boardNets: 0 };
  const add = (id, type, content) => nodes.set(id, { externalId: id, type, content });
  const link = (from, to, type) => links.push({ from, to, type });

  const designs = new Map(); // root schematic rel → { design, symbolsByPath }
  const cache = new Map();
  for (const rel of await rootSchematics(root, files.filter((file) => file.endsWith('.kicad_sch')))) {
    let design;
    try {
      design = await loadSchematic(root, rel, { cache });
    } catch (err) {
      errors.push({ file: rel, error: err.code ?? 'parse_error', message: err.message });
      continue;
    }
    const bom = billOfMaterials(design);
    const schId = externalId(project, 'schematic', rel);
    add(schId, 'schematic', schematicContent(rel, design, bom));
    counts.schematics += 1;
    const symbolsByPath = new Map();
    const symbolIds = new Map();
    for (const symbol of design.symbols) {
      const id = externalId(project, 'symbol', rel, symbol.reference);
      add(id, 'symbol', symbolContent(rel, symbol));
      link(id, schId, 'part_of');
      symbolIds.set(symbol.reference, id);
      for (const path of symbol.paths) symbolsByPath.set(path, symbol.reference);
      counts.symbols += 1;
    }
    for (const net of design.nets) {
      const id = externalId(project, 'net', rel, net.name);
      add(id, 'net', netContent(rel, net));
      link(id, schId, 'part_of');
      for (const reference of new Set(net.pins.map((pin) => pin.reference))) {
        if (symbolIds.has(reference)) link(id, symbolIds.get(reference), 'connects');
      }
      counts.nets += 1;
    }
    for (const row of bom) {
      const id = externalId(project, 'bom_row', rel, bomRowName(row));
      add(id, 'bom_row', bomContent(rel, row));
      link(id, schId, 'part_of');
      counts.bomRows += 1;
    }
    designs.set(rel, { symbolsByPath, symbolIds });
  }

  for (const rel of files.filter((file) => file.endsWith('.kicad_pcb'))) {
    let board;
    try {
      board = await loadBoard(root, rel);
    } catch (err) {
      errors.push({ file: rel, error: err.code ?? 'parse_error', message: err.message });
      continue;
    }
    const boardId = externalId(project, 'board', rel);
    add(boardId, 'board', boardContent(rel, board));
    counts.boards += 1;
    // The schematic a board implements: the one with the same name, else
    // the project's only schematic.
    const sibling = `${rel.slice(0, -'.kicad_pcb'.length)}.kicad_sch`;
    const schematic = designs.get(sibling) ?? (designs.size === 1 ? [...designs.values()][0] : null);
    const footprintIds = new Map();
    for (const footprint of board.footprints) {
      if (!footprint.reference) continue;
      const id = externalId(project, 'footprint', rel, footprint.reference);
      if (nodes.has(id)) continue;
      add(id, 'footprint', footprintContent(rel, footprint));
      link(id, boardId, 'part_of');
      footprintIds.set(footprint.reference, id);
      counts.footprints += 1;
      if (schematic) {
        // The footprint records the path of the symbol it was made from;
        // a board updated by hand may only share the reference.
        const reference = (footprint.path && schematic.symbolsByPath.get(footprint.path)) ?? footprint.reference;
        if (schematic.symbolIds.has(reference)) link(id, schematic.symbolIds.get(reference), 'implements');
      }
    }
    for (const net of board.nets) {
      const id = externalId(project, 'net', rel, net.name);
      add(id, 'net', boardNetContent(rel, net));
      link(id, boardId, 'part_of');
      for (const reference of new Set(net.pads.map((pad) => pad.reference))) {
        if (footprintIds.has(reference)) link(id, footprintIds.get(reference), 'connects');
      }
      counts.boardNets += 1;
    }
  }

  return { nodes: [...nodes.values()], links, errors, truncated, counts, files };
}

async function embedChanged(ownerId, records, embed) {
  const { rows } = await getPool().query(
    'SELECT external_id, content, embedding IS NOT NULL AS embedded FROM nodes WHERE owner_id = $1 AND source = $2 AND external_id = ANY($3::text[])',
    [ownerId, SOURCE, records.map((record) => record.externalId)]
  );
  const existing = new Map(rows.map((row) => [row.external_id, row]));
  const needed = records.filter((record) => {
    const row = existing.get(record.externalId);
    return !row || row.content !== record.content || !row.embedded;
  });
  const vectors = new Map();
  for (let i = 0; i < needed.length; i += EMBED_BATCH) {
    const batch = needed.slice(i, i + EMBED_BATCH);
    const embedded = await embed(batch.map((record) => record.content));
    batch.forEach((record, j) => vectors.set(record.externalId, embedded?.[j] ?? null));
  }
  return vectors;
}

const toVector = (embedding) => (embedding ? `[${embedding.join(',')}]` : null);

// Writes one project's graph. The whole replacement is one transaction, so
// a reader sees the old graph or the new one, never half of each.
export async function writeProjectGraph({ ownerId, project, privacy, graph, embed = tryEmbedDocuments }) {
  const vectors = await embedChanged(ownerId, graph.nodes, embed);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const ids = new Map();
    for (const record of graph.nodes) {
      const { rows } = await client.query(
        `INSERT INTO nodes (owner_id, type, content, embedding, source, external_id, project, privacy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (owner_id, source, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET
           type = EXCLUDED.type,
           content = EXCLUDED.content,
           -- An unchanged node keeps its vector; a changed one whose new
           -- vector could not be made is cleared for the backfill to redo.
           embedding = CASE
             WHEN EXCLUDED.embedding IS NOT NULL THEN EXCLUDED.embedding
             WHEN nodes.content = EXCLUDED.content THEN nodes.embedding
             ELSE NULL END,
           project = EXCLUDED.project,
           privacy = EXCLUDED.privacy
         RETURNING id`,
        [ownerId, record.type, record.content, toVector(vectors.get(record.externalId)), SOURCE, record.externalId, project, privacy]
      );
      ids.set(record.externalId, rows[0].id);
    }

    // What is no longer in the files goes, unless the scan stopped early
    // and so cannot say what is gone.
    let pruned = 0;
    if (!graph.truncated) {
      const prefix = `${encodeURIComponent(project)}|`;
      ({ rowCount: pruned } = await client.query(
        `DELETE FROM nodes
         WHERE owner_id = $1 AND source = $2 AND starts_with(external_id, $3) AND NOT (external_id = ANY($4::text[]))`,
        [ownerId, SOURCE, prefix, [...ids.keys()]]
      ));
    }

    // Links between the project's KiCad nodes are rebuilt from the files.
    // Links from anything else (an agent's notes) are left alone.
    const nodeIds = [...ids.values()];
    await client.query(
      `DELETE FROM node_relationships
       WHERE type = ANY($3::text[]) AND source_id = ANY($1::uuid[]) AND target_id = ANY($1::uuid[])
         AND EXISTS (SELECT 1 FROM nodes WHERE id = source_id AND owner_id = $2)`,
      [nodeIds, ownerId, STRUCTURAL]
    );
    const unique = new Map();
    for (const { from, to, type } of graph.links) {
      const sourceId = ids.get(from);
      const targetId = ids.get(to);
      if (sourceId && targetId && sourceId !== targetId) unique.set(`${sourceId}|${targetId}|${type}`, { sourceId, targetId, type });
    }
    const edges = [...unique.values()];
    if (edges.length) {
      await client.query(
        `INSERT INTO node_relationships (source_id, target_id, type)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[])
         ON CONFLICT (source_id, target_id, type) DO NOTHING`,
        [edges.map((e) => e.sourceId), edges.map((e) => e.targetId), edges.map((e) => e.type)]
      );
    }
    await client.query('COMMIT');
    return { ids, pruned, relationships: edges.length, embedded: [...vectors.values()].filter(Boolean).length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The whole ingest for one project: the folder the user bound to it.
export async function ingestProject({ ownerId, project, localPath, privacy = 'local', onProgress, embed } = {}) {
  if (!['local', 'cloud'].includes(privacy)) throw new KicadError('invalid_input', 'privacy must be local or cloud');
  let root;
  try {
    root = await realpath(localPath);
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new KicadError('no_checkout', 'the project folder is missing or is not a directory');
  }
  onProgress?.({ stage: 'reading', files: 0 });
  const graph = await buildProjectGraph({ root, project });
  onProgress?.({ stage: 'writing', files: graph.files.length, nodes: graph.nodes.length });
  const written = await writeProjectGraph({ ownerId, project, privacy, graph, embed });
  const summary = {
    project,
    files: graph.files.length,
    ...graph.counts,
    nodes: graph.nodes.length,
    relationships: written.relationships,
    embedded: written.embedded,
    pruned: written.pruned,
    truncated: graph.truncated,
    errors: graph.errors.sort((a, b) => compareRefs(a.file, b.file)),
  };
  onProgress?.({ stage: 'done', files: graph.files.length, nodes: graph.nodes.length });
  return summary;
}
