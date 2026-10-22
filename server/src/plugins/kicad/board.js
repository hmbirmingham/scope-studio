import { compareRefs } from './schematic.js';
import { KicadError, atom, child, children, head, num, parseSexpr, position, properties } from './sexpr.js';

// KiCad boards (KiCad 6+): footprints with their placement and pads, and the
// nets the pads are on. The pads carry the board's own netlist, so no
// geometry is needed to know what connects to what.

function padNet(pad, netNames) {
  const net = child(pad, 'net');
  if (!net) return null;
  // KiCad 6–8 write `(net <code> "<name>")`; a bare `(net "<name>")` is
  // accepted too.
  if (net.length >= 3) return net[2] || netNames.get(net[1]) || null;
  const only = net[1];
  return netNames.get(only) ?? (typeof only === 'string' && !/^\d+$/.test(only) ? only : null);
}

function parseFootprint(node, netNames) {
  const props = properties(node);
  // KiCad 6 kept reference and value as `fp_text`; KiCad 7+ as properties.
  const text = (kind) => children(node, 'fp_text').find((entry) => entry[1] === kind)?.[2] ?? null;
  const at = position(node) ?? { x: 0, y: 0, angle: 0 };
  const pads = children(node, 'pad').map((pad) => ({
    number: typeof pad[1] === 'string' ? pad[1] : '',
    kind: typeof pad[2] === 'string' ? pad[2] : '',
    net: padNet(pad, netNames),
  }));
  return {
    reference: props.Reference ?? text('reference') ?? '',
    value: props.Value ?? text('value') ?? '',
    footprint: typeof node[1] === 'string' ? node[1] : '',
    layer: atom(node, 'layer') ?? '',
    x: at.x,
    y: at.y,
    angle: at.angle,
    path: atom(node, 'path'),
    uuid: atom(node, 'uuid') ?? atom(node, 'tstamp'),
    pads,
  };
}

export function parseBoard(text) {
  const tree = parseSexpr(text);
  if (head(tree) !== 'kicad_pcb') throw new KicadError('not_a_board', 'the file is not a KiCad 6+ board (kicad_pcb)');

  const netNames = new Map();
  for (const net of children(tree, 'net')) {
    if (typeof net[1] === 'string' && typeof net[2] === 'string') netNames.set(net[1], net[2]);
  }
  // `module` is the KiCad 5 keyword, still found in files converted without
  // being re-saved.
  const footprints = [...children(tree, 'footprint'), ...children(tree, 'module')]
    .map((node) => parseFootprint(node, netNames))
    .sort((a, b) => compareRefs(a.reference, b.reference));

  const nets = new Map();
  for (const name of netNames.values()) if (name) nets.set(name, { name, pads: [] });
  for (const footprint of footprints) {
    for (const pad of footprint.pads) {
      if (!pad.net) continue;
      if (!nets.has(pad.net)) nets.set(pad.net, { name: pad.net, pads: [] });
      const list = nets.get(pad.net).pads;
      // A tab and the pin it repeats share a number; list the pad once.
      if (!list.some((entry) => entry.reference === footprint.reference && entry.pad === pad.number)) {
        list.push({ reference: footprint.reference, pad: pad.number });
      }
    }
  }
  for (const net of nets.values()) {
    net.pads.sort((a, b) => compareRefs(a.reference, b.reference) || compareRefs(a.pad, b.pad));
  }

  return {
    version: atom(tree, 'version'),
    generator: atom(tree, 'generator'),
    title: atom(child(tree, 'title_block'), 'title') ?? '',
    thickness: num(atom(child(tree, 'general'), 'thickness'), null),
    copperLayers: (child(tree, 'layers') ?? []).slice(1).filter((layer) => Array.isArray(layer) && /\.Cu$/.test(layer[1] ?? '')).map((layer) => layer[1]),
    footprints,
    nets: [...nets.values()].sort((a, b) => compareRefs(a.name, b.name)),
  };
}
