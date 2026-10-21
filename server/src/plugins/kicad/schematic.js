import { KicadError, atom, child, children, flag, head, num, parseSexpr, position, properties } from './sexpr.js';

// KiCad schematics (KiCad 6+): symbols with their pins, nets and the bill of
// materials. Net resolution is pragmatic rather than a full re-implementation
// of KiCad's connectivity engine:
//   - wires join at their end points, and any connection point (a pin, a
//     label, a junction, another wire's end) lying on a wire joins that wire;
//     two wires that merely cross are not joined unless a junction sits there;
//   - pins at the same point are joined;
//   - power symbols join every point carrying the same net name, anywhere in
//     the design, as do global labels and hidden power-input pins;
//   - local labels join points with the same name on one sheet;
//   - a sheet pin on the parent joins the hierarchical label of the same name
//     in the child sheet.
// Buses and bus entries are ignored, so signals carried only on a bus are
// reported as separate nets.

const GRID = 1e4; // KiCad stores millimetres to four decimals.
const MAX_SHEET_DEPTH = 16;
const MAX_SHEET_INSTANCES = 500;

const keyOf = (x, y) => `${Math.round(x * GRID)},${Math.round(y * GRID)}`;

export const NAME_PRIORITY = { power: 0, global: 1, local: 2, hierarchical: 3, implicit: 0 };

// "R10" sorts after "R9".
export function compareRefs(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

export function isGroundNet(name) {
  return /^(A|D|P|S|C)?GND[A-Z0-9_]*$|^GND|^VSS|^0V$|^EARTH$/i.test(String(name).replace(/^\//, ''));
}

function parsePin(pin, { unit, style }) {
  const at = position(pin) ?? { x: 0, y: 0, angle: 0 };
  return {
    type: typeof pin[1] === 'string' ? pin[1] : 'unspecified',
    number: atom(pin, 'number') ?? '',
    name: atom(pin, 'name') ?? '',
    x: at.x,
    y: at.y,
    unit,
    style,
    hidden: flag(pin, 'hide'),
  };
}

function parseLibSymbol(node) {
  const libId = typeof node[1] === 'string' ? node[1] : '';
  const pins = [];
  const collect = (owner, unit, style) => {
    for (const pin of children(owner, 'pin')) pins.push(parsePin(pin, { unit, style }));
  };
  collect(node, 0, 0);
  for (const sub of children(node, 'symbol')) {
    // Sub-symbols are named "<name>_<unit>_<style>"; unit 0 is common to
    // every unit, style 2 is the De Morgan alternate.
    const match = /_(\d+)_(\d+)$/.exec(sub[1] ?? '');
    collect(sub, match ? Number(match[1]) : 0, match ? Number(match[2]) : 0);
  }
  return {
    libId,
    power: Boolean(child(node, 'power')),
    extends: atom(node, 'extends'),
    pins,
    properties: properties(node),
  };
}

function parseSymbolInstance(node) {
  const at = position(node) ?? { x: 0, y: 0, angle: 0 };
  const instances = [];
  for (const project of children(child(node, 'instances'), 'project')) {
    for (const path of children(project, 'path')) {
      instances.push({ path: path[1], reference: atom(path, 'reference'), unit: num(atom(path, 'unit'), null) });
    }
  }
  return {
    libId: atom(node, 'lib_id') ?? '',
    libName: atom(node, 'lib_name'),
    x: at.x,
    y: at.y,
    angle: at.angle,
    mirror: atom(node, 'mirror'),
    unit: num(atom(node, 'unit'), 1),
    style: num(atom(node, 'convert') ?? atom(node, 'body_style'), 1),
    inBom: flag(node, 'in_bom', true),
    onBoard: flag(node, 'on_board', true),
    dnp: flag(node, 'dnp', false),
    uuid: atom(node, 'uuid'),
    properties: properties(node),
    instances,
  };
}

function points(node) {
  return children(child(node, 'pts'), 'xy').map((xy) => ({ x: num(xy[1]), y: num(xy[2]) }));
}

// One .kicad_sch file, as written. Connectivity is resolved by
// resolveDesign, because a sheet's nets depend on the sheets around it.
export function parseSchematicFile(text) {
  const tree = parseSexpr(text);
  if (head(tree) !== 'kicad_sch') throw new KicadError('not_a_schematic', 'the file is not a KiCad 6+ schematic (kicad_sch)');

  const libSymbols = new Map();
  for (const node of children(child(tree, 'lib_symbols'), 'symbol')) {
    const lib = parseLibSymbol(node);
    libSymbols.set(lib.libId, lib);
  }

  const wires = [];
  for (const wire of children(tree, 'wire')) {
    const pts = points(wire);
    for (let i = 1; i < pts.length; i++) wires.push([pts[i - 1], pts[i]]);
  }

  const labels = [];
  for (const [kind, keyword] of [['local', 'label'], ['global', 'global_label'], ['hierarchical', 'hierarchical_label']]) {
    for (const label of children(tree, keyword)) {
      const at = position(label);
      if (at && typeof label[1] === 'string') labels.push({ kind, name: label[1], x: at.x, y: at.y });
    }
  }

  const sheets = children(tree, 'sheet').map((sheet) => {
    const props = properties(sheet);
    return {
      uuid: atom(sheet, 'uuid'),
      name: props.Sheetname ?? props['Sheet name'] ?? '',
      file: props.Sheetfile ?? props['Sheet file'] ?? '',
      pins: children(sheet, 'pin')
        .map((pin) => ({ name: pin[1], ...(position(pin) ?? {}) }))
        .filter((pin) => typeof pin.name === 'string' && Number.isFinite(pin.x)),
    };
  });

  // KiCad 6 kept every symbol's per-sheet reference in one table at the end
  // of the root file; KiCad 7+ keeps it on the symbol itself.
  const legacyInstances = new Map();
  for (const path of children(child(tree, 'symbol_instances'), 'path')) {
    legacyInstances.set(path[1], { reference: atom(path, 'reference'), unit: num(atom(path, 'unit'), null) });
  }

  const titleBlock = child(tree, 'title_block');
  return {
    version: atom(tree, 'version'),
    generator: atom(tree, 'generator'),
    uuid: atom(tree, 'uuid'),
    title: atom(titleBlock, 'title') ?? '',
    revision: atom(titleBlock, 'rev') ?? '',
    libSymbols,
    symbols: children(tree, 'symbol').map(parseSymbolInstance),
    wires,
    junctions: children(tree, 'junction').map(position).filter(Boolean),
    noConnects: children(tree, 'no_connect').map(position).filter(Boolean),
    labels,
    sheets,
    legacyInstances,
  };
}

// The library symbol a placed symbol draws from, following `extends` for a
// derived symbol whose parent carries the pins.
function libraryFor(file, symbol) {
  let lib = file.libSymbols.get(symbol.libName ?? symbol.libId) ?? file.libSymbols.get(symbol.libId) ?? null;
  const seen = new Set();
  while (lib && lib.pins.length === 0 && lib.extends && !seen.has(lib.extends)) {
    seen.add(lib.extends);
    const prefix = lib.libId.includes(':') ? `${lib.libId.split(':')[0]}:` : '';
    const parent = file.libSymbols.get(`${prefix}${lib.extends}`) ?? file.libSymbols.get(lib.extends);
    if (!parent) break;
    lib = { ...lib, pins: parent.pins, power: lib.power || parent.power };
  }
  return lib;
}

// Library coordinates have Y pointing up; the sheet's Y points down. The
// symbol's rotation is counter-clockwise on screen, then its mirror applies.
export function pinPoint(symbol, pin) {
  let x = pin.x;
  let y = -pin.y;
  const turns = ((Math.round(symbol.angle / 90) % 4) + 4) % 4;
  for (let i = 0; i < turns; i++) [x, y] = [y, -x];
  if (symbol.mirror === 'x') y = -y;
  if (symbol.mirror === 'y') x = -x;
  const snap = (value) => Math.round(value * GRID) / GRID + 0;
  return { x: snap(symbol.x + x), y: snap(symbol.y + y) };
}

function onSegment(p, a, b) {
  const tolerance = 1 / GRID;
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  if (Math.abs(cross) / length > tolerance) return false;
  return (
    p.x >= Math.min(a.x, b.x) - tolerance && p.x <= Math.max(a.x, b.x) + tolerance &&
    p.y >= Math.min(a.y, b.y) - tolerance && p.y <= Math.max(a.y, b.y) + tolerance
  );
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  find(key) {
    if (!this.parent.has(key)) this.parent.set(key, key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let node = key;
    while (this.parent.get(node) !== root) {
      const next = this.parent.get(node);
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// The reference a placed symbol has on one sheet instance. A sheet used
// twice gives its symbols two references, recorded per instance path.
function referenceFor(symbol, root, sheetPath, symbolPath) {
  const instancePaths = [`/${[root.uuid, ...sheetPath].filter(Boolean).join('/')}`, `/${sheetPath.join('/')}`];
  for (const candidate of instancePaths) {
    const found = symbol.instances.find((instance) => instance.path === candidate && instance.reference);
    if (found) return { reference: found.reference, unit: found.unit ?? symbol.unit };
  }
  const legacy = root.legacyInstances.get(symbolPath);
  if (legacy?.reference) return { reference: legacy.reference, unit: legacy.unit ?? symbol.unit };
  return { reference: symbol.properties.Reference ?? '?', unit: symbol.unit };
}

function cleanValue(value) {
  return value == null || value === '~' ? '' : value;
}

// Resolves a design from its root schematic. `files` maps a path (relative
// to the project) to its parsed file; `rootPath` names the root. Sub-sheets
// are looked up relative to the sheet that uses them.
export function resolveDesign(files, rootPath) {
  const root = files.get(rootPath);
  if (!root) throw new KicadError('not_found', `${rootPath} was not parsed`);
  const uf = new UnionFind();
  const symbols = new Map(); // reference → merged symbol
  const realPins = []; // { key, symbol, pin }
  const names = new Map(); // union-find key → [{ name, kind }]
  const noConnectKeys = [];
  const missingSheets = [];
  const usedFiles = new Set([rootPath]);
  let instancesSeen = 0;
  let powerSymbols = 0;

  const addName = (key, name, kind) => {
    uf.find(key);
    if (!names.has(key)) names.set(key, []);
    names.get(key).push({ name, kind });
  };

  const visit = (filePath, file, sheetPath, sheetNames, depth) => {
    instancesSeen += 1;
    if (instancesSeen > MAX_SHEET_INSTANCES) throw new KicadError('design_too_large', `more than ${MAX_SHEET_INSTANCES} sheet instances`);
    const scope = sheetPath.join('/') || '';
    const point = (x, y) => `p|${scope}|${keyOf(x, y)}`;
    const localPrefix = `/${sheetNames.map((name) => `${name}/`).join('')}`;
    const anchors = [];
    const anchor = (x, y) => {
      const key = point(x, y);
      anchors.push({ x, y, key });
      return key;
    };

    for (const [a, b] of file.wires) uf.union(anchor(a.x, a.y), anchor(b.x, b.y));
    for (const junction of file.junctions) anchor(junction.x, junction.y);
    for (const flagAt of file.noConnects) noConnectKeys.push(anchor(flagAt.x, flagAt.y));

    for (const label of file.labels) {
      const key = anchor(label.x, label.y);
      if (label.kind === 'global') {
        uf.union(key, `g|${label.name}`);
        addName(key, label.name, 'global');
      } else if (label.kind === 'local') {
        uf.union(key, `l|${scope}|${label.name}`);
        addName(key, `${localPrefix}${label.name}`, 'local');
      } else {
        uf.union(key, `h|${scope}|${label.name}`);
        addName(key, `${localPrefix}${label.name}`, 'hierarchical');
      }
    }

    for (const symbol of file.symbols) {
      const lib = libraryFor(file, symbol);
      const symbolPath = `/${[...sheetPath, symbol.uuid].join('/')}`;
      const { reference, unit } = referenceFor(symbol, root, sheetPath, symbolPath);
      const pins = (lib?.pins ?? []).filter((pin) => (pin.unit === 0 || pin.unit === unit) && (pin.style === 0 || pin.style === symbol.style));

      if (lib?.power) {
        // A power port (a hidden power-input pin) names a global net after
        // the symbol's value (KiCad 7+), or after its pin (KiCad 6, where the
        // two agree). PWR_FLAG is a power symbol too, but its visible
        // power-output pin only marks a point as driven.
        powerSymbols += 1;
        for (const pin of pins) {
          const { x, y } = pinPoint(symbol, pin);
          const key = anchor(x, y);
          if (pin.type !== 'power_in' || !pin.hidden) continue;
          const netName = cleanValue(symbol.properties.Value) || pin.name || reference;
          uf.union(key, `g|${netName}`);
          addName(key, netName, 'power');
        }
        continue;
      }

      // Unannotated symbols ("R?") are kept apart rather than merged.
      const id = reference.includes('?') ? `${reference}#${symbolPath}` : reference;
      let merged = symbols.get(id);
      if (!merged) {
        merged = {
          reference,
          value: cleanValue(symbol.properties.Value),
          footprint: cleanValue(symbol.properties.Footprint),
          libId: symbol.libId,
          datasheet: cleanValue(symbol.properties.Datasheet),
          description: cleanValue(symbol.properties.Description ?? lib?.properties?.Description ?? ''),
          fields: Object.fromEntries(
            Object.entries(symbol.properties).filter(([name]) => !['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'].includes(name))
          ),
          inBom: symbol.inBom,
          onBoard: symbol.onBoard,
          dnp: symbol.dnp,
          sheet: filePath,
          paths: [],
          units: [],
          pins: [],
          missingLibrary: !lib,
        };
        symbols.set(id, merged);
      }
      merged.paths.push(symbolPath);
      merged.units.push(unit);
      for (const pin of pins) {
        const { x, y } = pinPoint(symbol, pin);
        const key = anchor(x, y);
        const entry = { reference, number: pin.number, name: pin.name, type: pin.type };
        merged.pins.push(entry);
        realPins.push({ key, entry });
        // A hidden power input joins the global net named after it, as
        // KiCad has always done for invisible power pins.
        if (pin.hidden && pin.type === 'power_in' && pin.name) {
          uf.union(key, `g|${pin.name}`);
          addName(key, pin.name, 'implicit');
        }
      }
    }

    for (const sheet of file.sheets) {
      const childPath = [...sheetPath, sheet.uuid];
      const sheetPins = sheet.pins.map((pin) => ({ ...pin, key: anchor(pin.x, pin.y) }));
      const childFile = resolveRelative(filePath, sheet.file);
      const parsed = files.get(childFile);
      if (!parsed || depth >= MAX_SHEET_DEPTH || sheetPath.includes(sheet.uuid)) {
        missingSheets.push(sheet.file);
        continue;
      }
      usedFiles.add(childFile);
      for (const pin of sheetPins) uf.union(pin.key, `h|${childPath.join('/')}|${pin.name}`);
      visit(childFile, parsed, childPath, [...sheetNames, sheet.name || sheet.uuid], depth + 1);
    }

    // Connection points that lie on a wire join it.
    for (const [a, b] of file.wires) {
      const wireKey = point(a.x, a.y);
      for (const candidate of anchors) {
        if (onSegment(candidate, a, b)) uf.union(candidate.key, wireKey);
      }
    }
  };

  visit(rootPath, root, [], [], 0);

  // Group pins and names by net.
  const groups = new Map();
  const groupOf = (key) => {
    const rootKey = uf.find(key);
    if (!groups.has(rootKey)) groups.set(rootKey, { pins: [], names: [], noConnect: false });
    return groups.get(rootKey);
  };
  // A pin shared by every unit of a multi-unit part is placed once per unit;
  // the net lists it once.
  for (const { key, entry } of realPins) {
    const group = groupOf(key);
    if (!group.pins.some((pin) => pin.reference === entry.reference && pin.number === entry.number)) group.pins.push(entry);
    else entry.duplicate = true;
  }
  for (const [key, list] of names) groupOf(key).names.push(...list);
  for (const key of noConnectKeys) groupOf(key).noConnect = true;

  const nets = [];
  const unconnected = [];
  const used = new Set();
  for (const group of groups.values()) {
    group.pins.sort((a, b) => compareRefs(a.reference, b.reference) || compareRefs(a.number, b.number));
    if (group.names.length === 0 && group.pins.length <= 1) {
      for (const pin of group.pins) {
        if (!group.noConnect && pin.type !== 'no_connect') unconnected.push(pin);
        pin.net = null;
      }
      continue;
    }
    if (group.pins.length === 0) continue;
    const ranked = [...group.names].sort((a, b) => NAME_PRIORITY[a.kind] - NAME_PRIORITY[b.kind] || a.name.localeCompare(b.name));
    let name = ranked[0]?.name ?? `Net-(${group.pins[0].reference}-Pad${group.pins[0].number})`;
    // Two unrelated groups can share a local name only if resolution above
    // missed a join; keep them apart rather than silently merging.
    if (used.has(name)) name = `${name}#${nets.length}`;
    used.add(name);
    const aliases = [...new Set(ranked.map((entry) => entry.name))].filter((alias) => alias !== name);
    const power = ranked.some((entry) => entry.kind === 'power' || entry.kind === 'implicit');
    for (const pin of group.pins) pin.net = name;
    nets.push({ name, aliases, power, ground: power && isGroundNet(name), noConnect: group.noConnect, pins: group.pins.map(({ net, ...pin }) => pin) });
  }
  nets.sort((a, b) => compareRefs(a.name, b.name));
  unconnected.sort((a, b) => compareRefs(a.reference, b.reference) || compareRefs(a.number, b.number));

  const symbolList = [...symbols.values()].sort((a, b) => compareRefs(a.reference, b.reference));
  for (const symbol of symbolList) {
    // A multi-unit part lists each shared pin once.
    const seen = new Set();
    symbol.pins = symbol.pins
      .filter((pin) => (seen.has(pin.number) ? false : seen.add(pin.number)))
      .sort((a, b) => compareRefs(a.number, b.number));
    symbol.units = [...new Set(symbol.units)].sort((a, b) => a - b);
  }

  return {
    root: rootPath,
    files: [...usedFiles],
    title: root.title,
    revision: root.revision,
    version: root.version,
    symbols: symbolList,
    nets,
    unconnected,
    powerSymbols,
    missingSheets,
  };
}

export function resolveRelative(fromFile, target) {
  const base = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/') + 1) : '';
  const parts = [];
  for (const segment of `${base}${String(target).replaceAll('\\', '/')}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

// Bill of materials: parts that are in the BOM and fitted, grouped by value
// and footprint, with quantities and references in natural order.
export function billOfMaterials(design) {
  const rows = new Map();
  for (const symbol of design.symbols) {
    if (!symbol.inBom || symbol.dnp || symbol.reference.startsWith('#')) continue;
    const key = `${symbol.value}\u0000${symbol.footprint}`;
    if (!rows.has(key)) rows.set(key, { value: symbol.value, footprint: symbol.footprint, libIds: new Set(), references: [] });
    const row = rows.get(key);
    row.references.push(symbol.reference);
    row.libIds.add(symbol.libId);
  }
  return [...rows.values()]
    .map((row) => {
      row.references.sort(compareRefs);
      return { value: row.value, footprint: row.footprint, quantity: row.references.length, references: row.references, libIds: [...row.libIds].sort() };
    })
    .sort((a, b) => compareRefs(a.references[0], b.references[0]));
}

export function parseSchematic(text, path = 'design.kicad_sch') {
  return resolveDesign(new Map([[path, parseSchematicFile(text)]]), path);
}
