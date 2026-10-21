// Invoice totals. Amounts are kept in cents so rounding happens once, at the
// line, and the total is an exact sum.

export function lineTotal({ unitCents, quantity, discountRate = 0 }) {
  const gross = unitCents * quantity;
  return Math.round(gross * (1 - discountRate));
}

export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}

export function taxCents(subtotalCents, taxRate) {
  return Math.round(subtotalCents * taxRate);
}

export function invoiceTotal(lines, taxRate) {
  const net = subtotal(lines);
  return net - taxCents(net, taxRate);
}
