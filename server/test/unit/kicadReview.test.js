import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { applyPhrasing, phraseWithModel, phrasingMessages, reviewDesign } from '../../src/plugins/kicad/review.js';
import { parseSchematic } from '../../src/plugins/kicad/schematic.js';
import { createFakeModelPort } from '../fakeModelPort.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kicad');
const design = (path) => parseSchematic(readFileSync(join(FIXTURES, path), 'utf8'), path);

describe('schematic review checks', () => {
  test('the clean fixture has nothing to report', () => {
    const review = reviewDesign(design('ldo-led/ldo-led.kicad_sch'));
    assert.deepEqual(review.issues, []);
    assert.equal(review.total, 0);
  });

  test('the faulty fixture: each planted fault is found, and nothing else', () => {
    const { issues } = reviewDesign(design('ldo-led-faulty/ldo-led-faulty.kicad_sch'));
    assert.deepEqual(issues.map((issue) => issue.id), [
      'missing_footprint:D1',
      'missing_value:R1',
      'no_decoupling:+3V3',
      'unconnected_pin:D1.1',
    ]);
    const decoupling = issues.find((issue) => issue.kind === 'no_decoupling');
    assert.deepEqual(decoupling.loads, ['U1.2']);
    assert.match(decoupling.text, /\+3V3 feeds U1 pin 2 \(VO\)/);
    assert.match(issues.find((issue) => issue.kind === 'unconnected_pin').text, /^D1 pin 1 \(K\) is not connected/);
    // TP1 carries a no-connect flag, so its lone pin is not an issue.
    assert.ok(!issues.some((issue) => issue.subject === 'TP1'));
  });

  test('a library placeholder value counts as missing; a DNP part needs no footprint', () => {
    const base = {
      nets: [],
      unconnected: [],
      symbols: [
        { reference: 'R1', value: 'R', libId: 'Device:R', footprint: 'R_0603', onBoard: true, dnp: false, pins: [] },
        { reference: 'R2', value: '1k', libId: 'Device:R', footprint: '', onBoard: true, dnp: true, pins: [] },
        { reference: 'H1', value: 'MountingHole', libId: 'Mechanical:MountingHole', footprint: '', onBoard: false, dnp: false, pins: [] },
      ],
    };
    assert.deepEqual(reviewDesign(base).issues.map((issue) => issue.id), ['missing_value:R1']);
  });

  test('ground nets and nets with only passives need no decoupling', () => {
    const pins = (net, ...entries) => entries.map(([reference, number, type]) => ({ reference, number, name: '', type, net }));
    const review = reviewDesign({
      unconnected: [],
      symbols: [
        { reference: 'U1', value: 'MCU', libId: 'MCU:X', footprint: 'QFN', onBoard: true, pins: [] },
        { reference: 'R1', value: '1k', libId: 'Device:R', footprint: 'R', onBoard: true, pins: [] },
      ],
      nets: [
        { name: 'GND', power: true, ground: true, pins: pins('GND', ['U1', '1', 'power_in']) },
        { name: '+12V', power: true, ground: false, pins: pins('+12V', ['R1', '1', 'passive']) },
        { name: '+3V3', power: true, ground: false, pins: pins('+3V3', ['U1', '2', 'power_in']) },
      ],
    });
    assert.deepEqual(review.issues.map((issue) => issue.id), ['no_decoupling:+3V3']);
  });
});

describe('phrasing the findings', () => {
  const { issues } = reviewDesign(design('ldo-led-faulty/ldo-led-faulty.kicad_sch'));

  test('the model is told the facts and asked only to word them', () => {
    const [system, user] = phrasingMessages(issues);
    assert.match(system.content, /Do not add, merge, drop or dispute/);
    const items = JSON.parse(user.content).items;
    assert.deepEqual(items.map((item) => item.id), issues.map((issue) => issue.id));
    assert.ok(items.every((item) => item.fact));
  });

  test('accepts a wording per issue only when it still names the part or net', () => {
    const reply = JSON.stringify({
      findings: [
        { id: 'missing_value:R1', text: 'Give R1 a resistance; the LED current depends on it.' },
        { id: 'missing_footprint:D1', text: 'The LED has no footprint.' },
        { id: 'no_decoupling:+3V3', text: 'Add a capacitor from +3V3 to GND\nnear U1.' },
        { id: 'invented:Q9', text: 'Q9 is backwards.' },
      ],
    });
    const { issues: phrased, accepted } = applyPhrasing(issues, `Sure! ${reply}`);
    assert.equal(accepted, 1);
    assert.equal(phrased.find((issue) => issue.id === 'missing_value:R1').phrased, 'Give R1 a resistance; the LED current depends on it.');
    assert.equal(phrased.find((issue) => issue.id === 'missing_footprint:D1').phrased, null, 'no longer names D1');
    assert.equal(phrased.find((issue) => issue.id === 'no_decoupling:+3V3').phrased, null, 'not one line');
    assert.equal(phrased.length, issues.length, 'an invented issue is not added');
  });

  test('an unusable reply keeps every plain wording', () => {
    for (const reply of ['not json at all', '{"findings": "nope"}', '', null]) {
      const result = applyPhrasing(issues, reply);
      assert.equal(result.accepted, 0);
      assert.ok(result.issues.every((issue) => issue.phrased === null));
    }
    const long = applyPhrasing(issues, JSON.stringify({ findings: [{ id: 'missing_value:R1', text: `R1 ${'x'.repeat(400)}` }] }));
    assert.equal(long.accepted, 0);
  });

  test('streams the reply from a ModelPort and asks for JSON', async () => {
    const port = createFakeModelPort({ responses: [{ findings: [{ id: 'unconnected_pin:D1.1', text: 'Connect D1 pin 1 (K) to GND.' }] }] });
    const result = await phraseWithModel(port, issues);
    assert.equal(result.accepted, 1);
    assert.equal(port.calls[0].format, 'json');
  });
});
