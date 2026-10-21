import { compareRefs } from './schematic.js';

// The schematic review. Every issue is found here, in code, from the
// resolved design; a model may only reword the issues it is given. Its reply
// is accepted per issue, only when it is well-formed and still names the
// part or net the issue is about, and anything else keeps the plain wording,
// so a model can neither invent an issue nor drop one.

const MAX_ISSUES = 50;
const MAX_PHRASE_CHARS = 300;

const isCapacitor = (symbol) => /^C\d/i.test(symbol.reference) || /^Device:C(_|$)|^Device:CP/.test(symbol.libId);

// Placeholder values the library ships with ("R" for Device:R), which mean
// nobody chose a value.
function placeholderValue(symbol) {
  const libName = symbol.libId.split(':')[1] ?? '';
  return symbol.libId.startsWith('Device:') && symbol.value === libName;
}

function pinLabel(pin) {
  const named = pin.name && pin.name !== '~' && pin.name !== pin.number;
  return `${pin.reference} pin ${pin.number}${named ? ` (${pin.name})` : ''}`;
}

export function reviewDesign(design) {
  const issues = [];
  const symbols = new Map(design.symbols.map((symbol) => [symbol.reference, symbol]));

  for (const pin of design.unconnected) {
    issues.push({
      id: `unconnected_pin:${pin.reference}.${pin.number}`,
      kind: 'unconnected_pin',
      severity: 'error',
      subject: pin.reference,
      reference: pin.reference,
      pin: pin.number,
      text: `${pinLabel(pin)} is not connected to anything and has no no-connect flag.`,
    });
  }

  for (const symbol of design.symbols) {
    if (symbol.reference.startsWith('#')) continue;
    if (!symbol.value) {
      issues.push({ id: `missing_value:${symbol.reference}`, kind: 'missing_value', severity: 'warning', subject: symbol.reference, reference: symbol.reference, text: `${symbol.reference} (${symbol.libId}) has no value.` });
    } else if (placeholderValue(symbol)) {
      issues.push({ id: `missing_value:${symbol.reference}`, kind: 'missing_value', severity: 'warning', subject: symbol.reference, reference: symbol.reference, text: `${symbol.reference} still has the library placeholder value "${symbol.value}".` });
    }
    if (symbol.onBoard && !symbol.dnp && !symbol.footprint) {
      issues.push({ id: `missing_footprint:${symbol.reference}`, kind: 'missing_footprint', severity: 'warning', subject: symbol.reference, reference: symbol.reference, text: `${symbol.reference} (${symbol.value || symbol.libId}) has no footprint assigned.` });
    }
  }

  // A supply net that feeds an IC pin needs a capacitor between it and
  // ground somewhere on the net.
  const groundNets = new Set(design.nets.filter((net) => net.ground).map((net) => net.name));
  for (const net of design.nets) {
    if (!net.power || net.ground) continue;
    const loads = net.pins.filter((pin) => {
      const symbol = symbols.get(pin.reference);
      return symbol && !isCapacitor(symbol) && (pin.type === 'power_in' || pin.type === 'power_out');
    });
    if (loads.length === 0) continue;
    const decoupled = design.symbols.some(
      (symbol) => isCapacitor(symbol) && symbol.pins.some((pin) => pin.net === net.name) && symbol.pins.some((pin) => groundNets.has(pin.net))
    );
    if (decoupled) continue;
    issues.push({
      id: `no_decoupling:${net.name}`,
      kind: 'no_decoupling',
      severity: 'warning',
      subject: net.name,
      net: net.name,
      loads: loads.map((pin) => `${pin.reference}.${pin.number}`),
      text: `Power net ${net.name} feeds ${loads.map(pinLabel).join(', ')} but has no capacitor to ground.`,
    });
  }

  issues.sort((a, b) => a.kind.localeCompare(b.kind) || compareRefs(a.subject, b.subject));
  return { issues: issues.slice(0, MAX_ISSUES), truncated: issues.length > MAX_ISSUES, total: issues.length };
}

export function phrasingMessages(issues) {
  const facts = issues.map(({ id, kind, severity, text }) => ({ id, kind, severity, fact: text }));
  return [
    {
      role: 'system',
      content:
        'You word the findings of an automated electronics schematic review for an engineer. Each item is a fact that was found by deterministic checks. ' +
        'Rewrite each fact as one short, specific sentence that says what is wrong and what to check or do. Do not add, merge, drop or dispute items, ' +
        'and keep every reference designator and net name exactly as given. Reply with JSON only: {"findings":[{"id":"<id>","text":"<sentence>"}]}.',
    },
    { role: 'user', content: JSON.stringify({ items: facts }) },
  ];
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Accepts the model's wording for an issue only when it is a short single
// string that still names the issue's subject.
export function applyPhrasing(issues, reply) {
  const parsed = extractJson(String(reply ?? ''));
  const byId = new Map();
  for (const entry of Array.isArray(parsed?.findings) ? parsed.findings : []) {
    if (typeof entry?.id === 'string' && typeof entry?.text === 'string') byId.set(entry.id, entry.text.trim());
  }
  let accepted = 0;
  const phrased = issues.map((issue) => {
    const text = byId.get(issue.id);
    if (text && text.length <= MAX_PHRASE_CHARS && !text.includes('\n') && text.includes(issue.subject)) {
      accepted += 1;
      return { ...issue, phrased: text };
    }
    return { ...issue, phrased: null };
  });
  return { issues: phrased, accepted };
}

export async function phraseWithModel(model, issues, { signal } = {}) {
  let text = '';
  for await (const chunk of model.stream({ messages: phrasingMessages(issues), maxTokens: 1200, signal, format: 'json' })) {
    if (chunk?.text) text += chunk.text;
  }
  return applyPhrasing(issues, text);
}
