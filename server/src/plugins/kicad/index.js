import { getPool } from '../../db/pool.js';
import { checkoutRoot } from '../code/paths.js';
import { defaultSandbox } from '../code/scripts.js';
import { createChecker, createToolProbe } from './cli.js';
import { chooseDesign, loadBoard, loadSchematic } from './files.js';
import { SOURCE, bomRowName, externalId } from './ingest.js';
import { phraseWithModel, reviewDesign } from './review.js';
import { billOfMaterials, compareRefs } from './schematic.js';
import { KicadError } from './sexpr.js';

// The KiCad vertical (docs/architecture/agent-workspace.md, "Verticals").
// Capabilities read the design files themselves, from the run's sandbox copy
// when it has one (so a read after an edit sees the edit) and otherwise from
// the project's folder, and point at the ingested nodes they are about so
// the map can show what the agent is looking at. They only read, so each is
// a `read_graph` capability on the `kicad` source.

const MAX_QUERY = 200;
const MAX_ROWS = 500;

function optionalString(input, key, max = MAX_QUERY) {
  const value = input?.[key];
  if (value == null) return null;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new KicadError('invalid_input', `${key} must be a non-empty string of at most ${max} characters`);
  return value;
}

const sameName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'accent' }) === 0;
// Net names are matched as written, or without KiCad's leading "/" for a
// local label, so "LED_A" finds "/LED_A".
const netMatches = (net, wanted) => [net.name, ...(net.aliases ?? [])].some((name) => sameName(name, wanted) || sameName(name.replace(/^\/(?:.*\/)?/, ''), wanted));

// The ingested nodes these external ids name, for `touchedNodeIds`. A
// project that was never ingested simply has none.
async function nodeIdsFor(ctx, ids) {
  if (!ctx?.ownerId || !ctx?.project || ids.length === 0) return [];
  const { rows } = await getPool().query(
    'SELECT id FROM nodes WHERE owner_id = $1 AND source = $2 AND external_id = ANY($3::text[])',
    [ctx.ownerId, SOURCE, ids.map((id) => externalId(ctx.project, ...id))]
  );
  return rows.map((row) => row.id);
}

async function nodePrivacy(ctx, kind, file) {
  if (!ctx?.ownerId || !ctx?.project) return 'local';
  const { rows } = await getPool().query(
    'SELECT privacy FROM nodes WHERE owner_id = $1 AND source = $2 AND external_id = $3',
    [ctx.ownerId, SOURCE, externalId(ctx.project, kind, file)]
  );
  // Files on this machine that were never ingested are treated as private.
  return rows[0]?.privacy ?? 'local';
}

async function openSchematic(input, ctx) {
  const root = checkoutRoot(ctx);
  const rel = await chooseDesign(root, { requested: optionalString(input, 'schematic', 1024), ext: '.kicad_sch' });
  return { rel, design: await loadSchematic(root, rel) };
}

async function openBoard(input, ctx) {
  const root = checkoutRoot(ctx);
  const rel = await chooseDesign(root, { requested: optionalString(input, 'board', 1024), ext: '.kicad_pcb' });
  return { rel, board: await loadBoard(root, rel) };
}

async function netQuery(input, ctx) {
  const netName = optionalString(input, 'net');
  const reference = optionalString(input, 'symbol');
  if ((netName == null) === (reference == null)) throw new KicadError('invalid_input', 'give exactly one of net or symbol');
  const { rel, design } = await openSchematic(input, ctx);

  if (netName != null) {
    const nets = design.nets.filter((net) => netMatches(net, netName));
    if (nets.length === 0) {
      const unconnected = design.unconnected.length;
      throw new KicadError('net_not_found', `no net named ${netName} in ${rel} (${design.nets.length} nets${unconnected ? `, ${unconnected} unconnected pins` : ''})`);
    }
    const output = {
      schematic: rel,
      nets: nets.map((net) => ({
        name: net.name,
        aliases: net.aliases,
        power: net.power,
        ground: net.ground,
        pins: net.pins,
        symbols: [...new Set(net.pins.map((pin) => pin.reference))].sort(compareRefs),
      })),
    };
    const touched = nets.flatMap((net) => [['net', rel, net.name], ...output.nets.find((entry) => entry.name === net.name).symbols.map((ref) => ['symbol', rel, ref])]);
    return { output, touchedNodeIds: await nodeIdsFor(ctx, touched) };
  }

  const symbol = design.symbols.find((entry) => sameName(entry.reference, reference));
  if (!symbol) throw new KicadError('symbol_not_found', `no symbol ${reference} in ${rel}`);
  const nets = [...new Set(symbol.pins.map((pin) => pin.net).filter(Boolean))].sort(compareRefs);
  const output = {
    schematic: rel,
    symbol: { reference: symbol.reference, value: symbol.value, footprint: symbol.footprint, libId: symbol.libId },
    pins: symbol.pins.map((pin) => ({ number: pin.number, name: pin.name, type: pin.type, net: pin.net ?? null })),
    nets,
  };
  return { output, touchedNodeIds: await nodeIdsFor(ctx, [['symbol', rel, symbol.reference], ...nets.map((name) => ['net', rel, name])]) };
}

async function footprintQuery(input, ctx) {
  const reference = optionalString(input, 'reference');
  const value = optionalString(input, 'value');
  const layer = optionalString(input, 'layer', 50);
  const net = optionalString(input, 'net');
  const { rel, board } = await openBoard(input, ctx);
  const matches = board.footprints.filter((footprint) =>
    (reference == null || sameName(footprint.reference, reference)) &&
    (value == null || sameName(footprint.value, value)) &&
    (layer == null || sameName(footprint.layer, layer)) &&
    (net == null || footprint.pads.some((pad) => pad.net && (sameName(pad.net, net) || sameName(pad.net.replace(/^\/(?:.*\/)?/, ''), net))))
  );
  if (reference != null && matches.length === 0) throw new KicadError('footprint_not_found', `no footprint ${reference} on ${rel}`);
  const footprints = matches.slice(0, MAX_ROWS).map((footprint) => ({
    reference: footprint.reference,
    value: footprint.value,
    footprint: footprint.footprint,
    layer: footprint.layer,
    x: footprint.x,
    y: footprint.y,
    angle: footprint.angle,
    pads: footprint.pads.filter((pad) => pad.number).map((pad) => ({ number: pad.number, net: pad.net })),
  }));
  return {
    output: { board: rel, count: matches.length, truncated: matches.length > footprints.length, footprints },
    touchedNodeIds: await nodeIdsFor(ctx, footprints.map((footprint) => ['footprint', rel, footprint.reference])),
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  // A leading =, +, - or @ would be a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function bomCsv(rows) {
  const lines = [['References', 'Quantity', 'Value', 'Footprint', 'Library'].join(',')];
  for (const row of rows) lines.push([row.references.join(' '), row.quantity, row.value, row.footprint, row.libIds.join(' ')].map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}

async function bom(input, ctx) {
  const { rel, design } = await openSchematic(input, ctx);
  const rows = billOfMaterials(design);
  const columns = ['references', 'quantity', 'value', 'footprint', 'libIds'];
  const parts = rows.reduce((sum, row) => sum + row.quantity, 0);
  return {
    output: { schematic: rel, columns, rows, lines: rows.length, parts },
    artifacts: [{ name: `Bill of materials — ${rel} (${rows.length} lines, ${parts} parts)`, content: bomCsv(rows) }],
    touchedNodeIds: await nodeIdsFor(ctx, rows.map((row) => ['bom_row', rel, bomRowName(row)])),
  };
}

// The model may only phrase findings about private data when the call
// cannot leave the machine: the engine is offline, or the agent's policy is
// local only. ctx.model's routing follows the step's slice, which need not
// hold the design, so this is decided here rather than assumed.
function modelMayPhrase(ctx, privacy) {
  if (!ctx?.model || typeof ctx.model.stream !== 'function') return { allowed: false, reason: 'no_model' };
  if (privacy !== 'local') return { allowed: true, reason: 'cloud_data' };
  if (ctx.model.offline === true) return { allowed: true, reason: 'offline' };
  if (ctx.agent?.modelPolicy === 'local_only') return { allowed: true, reason: 'local_only_policy' };
  return { allowed: false, reason: 'private_design' };
}

async function schematicReview(input, ctx) {
  const { rel, design } = await openSchematic(input, ctx);
  const review = reviewDesign(design);
  let issues = review.issues.map((issue) => ({ ...issue, phrased: null }));
  let phrasing = { by: 'template', reason: issues.length === 0 ? 'no_issues' : null, accepted: 0 };

  if (issues.length > 0) {
    const gate = modelMayPhrase(ctx, await nodePrivacy(ctx, 'schematic', rel));
    if (!gate.allowed) {
      phrasing.reason = gate.reason;
    } else {
      try {
        const result = await phraseWithModel(ctx.model, issues, { signal: ctx.signal });
        issues = result.issues;
        phrasing = { by: result.accepted > 0 ? 'model' : 'template', reason: result.accepted > 0 ? gate.reason : 'model_reply_unusable', accepted: result.accepted };
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        phrasing.reason = 'model_failed';
      }
    }
  }

  const findings = issues.length > 0
    ? issues.slice(0, 9).map((issue) => ({ name: `Schematic review — ${rel}: ${issue.kind.replaceAll('_', ' ')}`, content: issue.phrased ?? issue.text }))
    : [{ name: `Schematic review — ${rel}`, content: `No unconnected pins, missing values or footprints, or undecoupled power nets in ${design.symbols.length} parts and ${design.nets.length} nets.` }];
  if (issues.length > 9) findings.push({ name: `Schematic review — ${rel}: more`, content: `${issues.length - 9} more issues: ${issues.slice(9).map((issue) => issue.text).join(' ')}` });

  const counts = {};
  for (const issue of issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  const touched = issues.flatMap((issue) => (issue.net ? [['net', rel, issue.net]] : issue.reference ? [['symbol', rel, issue.reference]] : []));
  return {
    output: {
      schematic: rel,
      checked: { parts: design.symbols.length, nets: design.nets.length },
      counts,
      issues: issues.map(({ phrased, ...issue }) => ({ ...issue, text: phrased ?? issue.text, fact: issue.text })),
      truncated: review.truncated,
      phrasing,
    },
    findings,
    touchedNodeIds: await nodeIdsFor(ctx, [['schematic', rel], ...touched]),
  };
}

const designInput = (key, description) => ({ [key]: { type: 'string', description } });

export function createKicadPlugin({ sandbox = defaultSandbox, probe = createToolProbe(), makeScratch, removeScratch } = {}) {
  const checker = createChecker({ sandbox, probe, makeScratch, removeScratch });
  const capability = (name, description, properties, run) => ({
    name,
    description,
    tags: ['kicad'],
    permission: 'read_graph',
    source: SOURCE,
    input: { type: 'object', properties },
    verifiers: [],
    run,
  });
  const schematicArg = designInput('schematic', 'The .kicad_sch to read, relative to the project; optional when the project has one root schematic.');
  const boardArg = designInput('board', 'The .kicad_pcb to read, relative to the project; optional when the project has one board.');

  return {
    name: 'kicad',
    capabilities: [
      capability('kicad.net_query', 'Which pins and symbols are on a net, or which nets a symbol touches.', {
        ...schematicArg,
        net: { type: 'string', description: 'A net name, e.g. "+3V3" or "LED_A".' },
        symbol: { type: 'string', description: 'A reference designator, e.g. "U1".' },
      }, netQuery),
      capability('kicad.footprint_query', 'Footprints on the board, filtered by reference, value, layer or net, with placement and pad nets.', {
        ...boardArg,
        reference: { type: 'string' },
        value: { type: 'string' },
        layer: { type: 'string', description: 'e.g. "F.Cu" or "B.Cu".' },
        net: { type: 'string' },
      }, footprintQuery),
      capability('kicad.bom', 'The bill of materials as a table (and a CSV artifact), grouped by value and footprint.', { ...schematicArg }, bom),
      capability('kicad.schematic_review', 'Review a schematic for unconnected pins, missing values or footprints and power nets without decoupling.', { ...schematicArg }, schematicReview),
    ],
    // Design checks for capabilities that change a design (and for task
    // checks); the read-only capabilities above change nothing, so a design
    // that fails ERC must not fail them.
    verifiers: [
      { name: 'kicad.erc', tags: ['kicad'], verify: (result, ctx) => checker.check('erc', result, ctx) },
      { name: 'kicad.drc', tags: ['kicad'], verify: (result, ctx) => checker.check('drc', result, ctx) },
    ],
    probe,
  };
}

export default createKicadPlugin();
