import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { parseBoard } from '../../src/plugins/kicad/board.js';
import {
  billOfMaterials,
  compareRefs,
  isGroundNet,
  parseSchematic,
  parseSchematicFile,
  pinPoint,
  resolveDesign,
  resolveRelative,
} from '../../src/plugins/kicad/schematic.js';
import { KicadError, flag, parseSexpr, properties } from '../../src/plugins/kicad/sexpr.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kicad');
const fixture = (path) => readFileSync(join(FIXTURES, path), 'utf8');

const netByName = (design, name) => design.nets.find((net) => net.name === name);
const pinsOf = (net) => net.pins.map((pin) => `${pin.reference}.${pin.number}`);

// Small schematics written inline, to pin down one connectivity rule each.
const LIB = `
  (lib_symbols
    (symbol "Device:R" (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 0 0 0)) (property "Value" "R" (at 0 0 0))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))))
    (symbol "power:GND" (power) (in_bom no) (on_board no)
      (property "Reference" "#PWR" (at 0 0 0)) (property "Value" "GND" (at 0 0 0))
      (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) hide (name "GND") (number "1"))))
    (symbol "Amp:Dual" (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 0 0)) (property "Value" "Dual" (at 0 0 0))
      (symbol "Dual_0_1" (pin power_in line (at 0 5.08 270) (length 2.54) hide (name "VCC") (number "8")))
      (symbol "Dual_1_1" (pin output line (at 5.08 0 180) (length 2.54) (name "OUTA") (number "1")))
      (symbol "Dual_2_1" (pin output line (at 5.08 0 180) (length 2.54) (name "OUTB") (number "7")))))
`;

const resistor = (ref, x, y, { angle = 0, value = '10k', footprint = 'R_0603', uuid = ref, extra = '' } = {}) =>
  `(symbol (lib_id "Device:R") (at ${x} ${y} ${angle}) (unit 1) (in_bom yes) (on_board yes) (uuid "${uuid}")
     (property "Reference" "${ref}" (at 0 0 0)) (property "Value" "${value}" (at 0 0 0)) (property "Footprint" "${footprint}" (at 0 0 0)) ${extra})`;
const wire = (x1, y1, x2, y2) => `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})))`;
const sch = (body, extra = '') => `(kicad_sch (version 20231120) (generator "eeschema") (uuid "root-uuid") ${extra} ${LIB} ${body})`;

describe('S-expression reader', () => {
  test('reads lists, atoms and escaped strings', () => {
    const tree = parseSexpr('(kicad_sch (version 20231120) (title "A \\"quoted\\" \\\\ title\\nline") (empty ""))');
    assert.deepEqual(tree, ['kicad_sch', ['version', '20231120'], ['title', 'A "quoted" \\ title\nline'], ['empty', '']]);
  });

  test('tolerates a byte order mark and trailing whitespace', () => {
    assert.deepEqual(parseSexpr('﻿(a b)\n\n'), ['a', 'b']);
  });

  test('reports malformed input with a line number instead of half-reading it', () => {
    const cases = [
      ['(a (b c)', /never closed/],
      ['(a))', /unbalanced/],
      ['(a "open)', /unterminated string/],
      ['(a)(b)', /after the end/],
      ['atom', /expected "\("/],
      ['   ', /empty/],
    ];
    for (const [text, message] of cases) {
      assert.throws(() => parseSexpr(text), (err) => err instanceof KicadError && err.code === 'parse_error' && message.test(err.message), text);
    }
    assert.throws(() => parseSexpr('(a\n(b\n)'), /line 3/);
  });

  test('refuses absurd nesting without overflowing the stack', () => {
    const deep = `${'('.repeat(100_000)}${')'.repeat(100_000)}`;
    assert.throws(() => parseSexpr(deep), /nested more than 256/);
  });

  test('flags in KiCad 6 (bare) and KiCad 8 (yes/no) form, and properties', () => {
    assert.equal(flag(['pin', 'passive', 'line', 'hide'], 'hide'), true);
    assert.equal(flag(['pin', ['hide', 'yes']], 'hide'), true);
    assert.equal(flag(['pin', ['hide', 'no']], 'hide'), false);
    assert.equal(flag(['symbol'], 'in_bom', true), true);
    assert.deepEqual(properties(['symbol', ['property', 'Reference', 'R1'], ['property', 'Value', '1k'], ['property', 'Value', 'dup']]), { Reference: 'R1', Value: '1k' });
  });
});

describe('schematic parsing', () => {
  const design = parseSchematic(fixture('ldo-led/ldo-led.kicad_sch'), 'ldo-led.kicad_sch');

  test('reads the fixture’s parts, values, footprints and fields', () => {
    assert.equal(design.title, 'LDO regulator with LED');
    assert.equal(design.revision, '1');
    assert.deepEqual(design.symbols.map((s) => s.reference), ['C1', 'C2', 'D1', 'J1', 'R1', 'U1']);
    const u1 = design.symbols.find((s) => s.reference === 'U1');
    assert.equal(u1.value, 'AMS1117-3.3');
    assert.equal(u1.libId, 'Regulator_Linear:AMS1117-3.3');
    assert.equal(u1.footprint, 'Package_TO_SOT_SMD:SOT-223-3_TabPin2');
    assert.deepEqual(u1.pins.map((pin) => [pin.number, pin.name, pin.type, pin.net]), [
      ['1', 'GND', 'power_in', 'GND'],
      ['2', 'VO', 'power_out', '+3V3'],
      ['3', 'VI', 'power_in', '+5V'],
    ]);
    assert.equal(design.powerSymbols, 10, 'power ports and PWR_FLAGs are counted but are not parts');
  });

  test('resolves nets from wires, junctions, labels and power ports', () => {
    assert.deepEqual(design.nets.map((net) => net.name).sort(), ['+3V3', '+5V', '/LED_A', 'GND']);
    assert.deepEqual(pinsOf(netByName(design, '+5V')), ['C1.1', 'J1.1', 'U1.3']);
    assert.deepEqual(pinsOf(netByName(design, 'GND')), ['C1.2', 'C2.2', 'D1.1', 'J1.2', 'U1.1']);
    assert.deepEqual(pinsOf(netByName(design, '+3V3')), ['C2.1', 'R1.1', 'U1.2']);
    // A local label on the middle of a wire names that wire's net, with
    // KiCad's leading "/" for the root sheet.
    assert.deepEqual(pinsOf(netByName(design, '/LED_A')), ['D1.2', 'R1.2']);
    // The power port outranks the global label on the same wire.
    assert.deepEqual(netByName(design, '+5V').aliases, ['VIN']);
    assert.equal(netByName(design, 'GND').ground, true);
    assert.equal(netByName(design, '+3V3').power, true);
    assert.equal(netByName(design, '+3V3').ground, false);
    assert.equal(netByName(design, '/LED_A').power, false);
    assert.deepEqual(design.unconnected, []);
  });

  test('the faulty copy has one unconnected pin; a no-connect flag silences another', () => {
    const faulty = parseSchematic(fixture('ldo-led-faulty/ldo-led-faulty.kicad_sch'));
    assert.deepEqual(faulty.unconnected.map((pin) => `${pin.reference}.${pin.number}`), ['D1.1']);
    assert.ok(faulty.symbols.some((s) => s.reference === 'TP1'));
    assert.equal(faulty.symbols.find((s) => s.reference === 'R1').value, '', '"~" is an empty value');
    assert.equal(faulty.symbols.find((s) => s.reference === 'D1').footprint, '');
  });

  test('wires that cross without a junction stay apart; a junction joins them', () => {
    // R1 pin 2 is at (10, 13.81); R2 pin 1 at (20, 20). The wires cross at
    // (10, 20), in the middle of both.
    const crossing = sch(`${resistor('R1', 10, 10)} ${resistor('R2', 20, 23.81)}
      ${wire(10, 13.81, 10, 30)} ${wire(0, 20, 20, 20)}`);
    const apart = parseSchematic(crossing);
    assert.equal(apart.nets.length, 0, 'no net joins two pins');
    assert.deepEqual(apart.unconnected.map((p) => `${p.reference}.${p.number}`), ['R1.1', 'R1.2', 'R2.1', 'R2.2']);

    const joined = parseSchematic(crossing.replace(/\)$/, ' (junction (at 10 20)))'));
    assert.equal(joined.nets.length, 1);
    assert.deepEqual(pinsOf(joined.nets[0]), ['R1.2', 'R2.1']);
    assert.match(joined.nets[0].name, /^Net-\(R1-Pad2\)$/);
  });

  test('a wire end on the middle of another wire joins it (a T)', () => {
    const tee = parseSchematic(sch(`${resistor('R1', 10, 10)} ${resistor('R2', 20, 0)} ${resistor('R3', 30, 10)}
      ${wire(10, 13.81, 30, 13.81)} ${wire(20, 3.81, 20, 13.81)}`));
    assert.deepEqual(pinsOf(tee.nets[0]), ['R1.2', 'R2.2', 'R3.2']);
  });

  test('global and local labels join points without wires; local names stay on their sheet', () => {
    const labelled = parseSchematic(sch(`${resistor('R1', 10, 10)} ${resistor('R2', 50, 10)} ${resistor('R3', 90, 10)}
      (global_label "SDA" (shape bidirectional) (at 10 13.81 0)) (global_label "SDA" (shape bidirectional) (at 50 13.81 0))
      (label "EN" (at 50 6.19 0)) (label "EN" (at 90 6.19 0))`));
    assert.deepEqual(pinsOf(netByName(labelled, 'SDA')), ['R1.2', 'R2.2']);
    assert.deepEqual(pinsOf(netByName(labelled, '/EN')), ['R2.1', 'R3.1']);
  });

  test('a rotated symbol’s pins land where KiCad draws them', () => {
    const pin = { x: 0, y: 3.81 };
    assert.deepEqual(pinPoint({ x: 10, y: 10, angle: 0 }, pin), { x: 10, y: 6.19 });
    const turned = pinPoint({ x: 10, y: 10, angle: 90 }, pin);
    assert.ok(Math.abs(turned.x - 6.19) < 1e-9 && Math.abs(turned.y - 10) < 1e-9, JSON.stringify(turned));
    const mirrored = pinPoint({ x: 10, y: 10, angle: 0, mirror: 'x' }, pin);
    assert.ok(Math.abs(mirrored.y - 13.81) < 1e-9);
    // A horizontal resistor wired at its rotated pin positions is connected.
    const rotated = parseSchematic(sch(`${resistor('R1', 10, 10, { angle: 90 })} ${resistor('R2', 30, 10)}
      ${wire(6.19, 10, 6.19, 0)} ${wire(6.19, 0, 30, 0)} ${wire(30, 0, 30, 6.19)}`));
    assert.deepEqual(pinsOf(rotated.nets[0]), ['R1.1', 'R2.1']);
  });

  test('multi-unit parts merge into one symbol; hidden power pins join their global net', () => {
    const dual = parseSchematic(sch(`
      (symbol (lib_id "Amp:Dual") (at 10 10 0) (unit 1) (uuid "a") (property "Reference" "U1" (at 0 0 0)) (property "Value" "Dual" (at 0 0 0)) (property "Footprint" "SOIC-8" (at 0 0 0)))
      (symbol (lib_id "Amp:Dual") (at 40 10 0) (unit 2) (uuid "b") (property "Reference" "U1" (at 0 0 0)) (property "Value" "Dual" (at 0 0 0)) (property "Footprint" "SOIC-8" (at 0 0 0)))
      ${resistor('R1', 60, 10)} ${wire(15.08, 10, 15.08, 0)} ${wire(15.08, 0, 60, 0)} ${wire(60, 0, 60, 6.19)}
      (symbol (lib_id "power:GND") (at 80 10 0) (unit 1) (uuid "g") (property "Reference" "#PWR01" (at 0 0 0)) (property "Value" "VCC" (at 0 0 0)))
      ${wire(80, 10, 60, 13.81)}`));
    assert.deepEqual(dual.symbols.map((s) => s.reference), ['R1', 'U1']);
    const u1 = dual.symbols.find((s) => s.reference === 'U1');
    assert.deepEqual(u1.units, [1, 2]);
    assert.deepEqual(u1.pins.map((pin) => pin.number), ['1', '7', '8'], 'the common pin is listed once');
    assert.deepEqual(pinsOf(netByName(dual, 'Net-(R1-Pad1)')), ['R1.1', 'U1.1']);
    // U1's hidden VCC pin and the power port valued VCC are the same net.
    assert.deepEqual(pinsOf(netByName(dual, 'VCC')), ['R1.2', 'U1.8']);
    assert.ok(dual.unconnected.some((pin) => pin.reference === 'U1' && pin.number === '7'));
  });

  test('hierarchical sheets: sheet pins join hierarchical labels; local names carry the sheet path', () => {
    const child = parseSchematicFile(sch(`${resistor('R2', 10, 10, { uuid: 'r2' })}
      (hierarchical_label "IN" (shape input) (at 10 6.19 180)) (label "MID" (at 10 13.81 0))`));
    const root = parseSchematicFile(sch(`${resistor('R1', 10, 10, { uuid: 'r1' })}
      ${wire(10, 13.81, 30, 13.81)}
      (sheet (at 30 10) (size 20 10) (uuid "sheet-1")
        (property "Sheetname" "Filter" (at 0 0 0)) (property "Sheetfile" "sub/filter.kicad_sch" (at 0 0 0))
        (pin "IN" input (at 30 13.81 180)))
      (sheet (at 30 40) (size 20 10) (uuid "sheet-2")
        (property "Sheetname" "Missing" (at 0 0 0)) (property "Sheetfile" "gone.kicad_sch" (at 0 0 0)))`));
    const design = resolveDesign(new Map([['top.kicad_sch', root], ['sub/filter.kicad_sch', child]]), 'top.kicad_sch');
    assert.deepEqual(design.files, ['top.kicad_sch', 'sub/filter.kicad_sch']);
    assert.deepEqual(design.missingSheets, ['gone.kicad_sch']);
    const net = design.nets.find((entry) => pinsOf(entry).includes('R1.2'));
    assert.deepEqual(pinsOf(net), ['R1.2', 'R2.1']);
    assert.ok(design.nets.some((entry) => entry.name === '/Filter/MID'), design.nets.map((n) => n.name).join());
    assert.deepEqual(design.symbols.find((s) => s.reference === 'R2').paths, ['/sheet-1/r2']);
  });

  test('per-instance references (KiCad 7+) and the KiCad 6 symbol_instances table', () => {
    const modern = parseSchematic(sch(resistor('R?', 10, 10, { extra: '(instances (project "p" (path "/root-uuid" (reference "R7") (unit 1))))' })));
    assert.equal(modern.symbols[0].reference, 'R7');
    const legacy = parseSchematic(sch(resistor('R?', 10, 10, { uuid: 'u-1' }), '(symbol_instances (path "/u-1" (reference "R9") (unit 1)))'));
    assert.equal(legacy.symbols[0].reference, 'R9');
  });

  test('refuses a file that is not a schematic', () => {
    assert.throws(() => parseSchematicFile('(kicad_pcb (version 1))'), (err) => err.code === 'not_a_schematic');
  });

  test('bill of materials: grouped by value and footprint, DNP and power parts left out', () => {
    const parts = parseSchematic(sch(`${resistor('R10', 0, 0)} ${resistor('R2', 20, 0)} ${resistor('R3', 40, 0, { value: '1k' })}
      ${resistor('R4', 60, 0, { extra: '(dnp yes)' })} ${resistor('R5', 80, 0, { footprint: 'R_0805' })}
      (symbol (lib_id "Device:R") (at 100 0 0) (in_bom no) (uuid "x") (property "Reference" "R6" (at 0 0 0)) (property "Value" "10k" (at 0 0 0)))`));
    const rows = billOfMaterials(parts);
    assert.deepEqual(rows.map((row) => [row.value, row.footprint, row.quantity, row.references.join(' ')]), [
      ['10k', 'R_0603', 2, 'R2 R10'],
      ['1k', 'R_0603', 1, 'R3'],
      ['10k', 'R_0805', 1, 'R5'],
    ]);
    assert.deepEqual(rows[0].libIds, ['Device:R']);
  });

  test('helpers: natural reference order, ground names, sheet paths', () => {
    assert.deepEqual(['R10', 'R2', 'C1', 'R1'].sort(compareRefs), ['C1', 'R1', 'R2', 'R10']);
    for (const name of ['GND', 'AGND', 'GNDA', 'VSS', '0V', '/GND']) assert.equal(isGroundNet(name), true, name);
    for (const name of ['+3V3', 'VCC', 'SIGNAL_GROUNDED_X']) assert.equal(isGroundNet(name), false, name);
    assert.equal(resolveRelative('a/b/top.kicad_sch', '../c/sub.kicad_sch'), 'a/c/sub.kicad_sch');
    assert.equal(resolveRelative('top.kicad_sch', 'sub\\x.kicad_sch'), 'sub/x.kicad_sch');
  });
});

describe('board parsing', () => {
  const board = parseBoard(fixture('ldo-led/ldo-led.kicad_pcb'));

  test('reads footprints with placement, layer, symbol path and pad nets', () => {
    assert.deepEqual(board.footprints.map((f) => f.reference), ['C1', 'C2', 'D1', 'J1', 'R1', 'U1']);
    const r1 = board.footprints.find((f) => f.reference === 'R1');
    assert.equal(r1.value, '330');
    assert.equal(r1.footprint, 'Resistor_SMD:R_0603_1608Metric');
    assert.equal(r1.layer, 'F.Cu');
    assert.deepEqual([r1.x, r1.y, r1.angle], [138, 100, 90]);
    assert.match(r1.path, /^\/9e1f0c3d-/);
    assert.deepEqual(r1.pads.map((pad) => [pad.number, pad.net]), [['1', '+3V3'], ['2', '/LED_A']]);
    assert.equal(board.footprints.find((f) => f.reference === 'C2').layer, 'B.Cu');
    assert.deepEqual(board.copperLayers, ['F.Cu', 'B.Cu']);
    assert.equal(board.thickness, 1.6);
  });

  test('nets list each pad once, the regulator’s tab included', () => {
    const net = board.nets.find((entry) => entry.name === '+3V3');
    assert.deepEqual(net.pads.map((pad) => `${pad.reference}.${pad.pad}`), ['C2.1', 'R1.1', 'U1.2']);
    assert.deepEqual(board.nets.map((entry) => entry.name).sort(), ['+3V3', '+5V', '/LED_A', 'GND']);
  });

  test('KiCad 6 fp_text references and name-only pad nets', () => {
    const old = parseBoard(`(kicad_pcb (version 20211014) (net 0 "") (net 1 "VCC")
      (footprint "R_0603" (layer "B.Cu") (at 1 2 180)
        (fp_text reference "R5" (at 0 0)) (fp_text value "47k" (at 0 0))
        (pad "1" smd rect (net 1 "VCC")) (pad "2" smd rect (net "SIG")) (pad "" np_thru_hole circle)))`);
    assert.equal(old.footprints[0].reference, 'R5');
    assert.equal(old.footprints[0].value, '47k');
    assert.deepEqual(old.footprints[0].pads.map((pad) => pad.net), ['VCC', 'SIG', null]);
    assert.deepEqual(old.nets.map((net) => net.name), ['SIG', 'VCC']);
  });

  test('refuses a file that is not a board', () => {
    assert.throws(() => parseBoard('(kicad_sch (version 1))'), (err) => err.code === 'not_a_board');
  });
});
