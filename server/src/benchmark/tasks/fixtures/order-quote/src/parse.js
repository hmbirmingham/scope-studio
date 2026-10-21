// Parses the order export: one item per line, `sku,quantity,unitCents,gramsEach`.
// Blank lines and `#` comments are skipped so exports can be annotated.

export class ParseError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

function integer(value, line, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new ParseError(line, `${field} must be a whole number, not "${value}"`);
  return number;
}

export function parseOrder(text) {
  const items = [];
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const fields = trimmed.split(',').map((field) => field.trim());
    if (fields.length !== 4) throw new ParseError(line, `expected 4 fields, found ${fields.length}`);
    const [sku, quantity, unitCents, gramsEach] = fields;
    if (!/^[A-Z0-9-]+$/.test(sku)) throw new ParseError(line, `"${sku}" is not a SKU`);
    items.push({
      sku,
      quantity: integer(quantity, line, 'quantity'),
      unitCents: integer(unitCents, line, 'unitCents'),
      gramsEach: integer(gramsEach, line, 'gramsEach'),
    });
  });
  return items;
}
