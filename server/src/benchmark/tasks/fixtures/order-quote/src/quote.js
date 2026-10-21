import { parseOrder } from './parse.js';
import { subtotalCents } from './price.js';
import { shippingCents } from './shipping.js';
import { validateOrder } from './validate.js';

// A customer quote from an order export: the subtotal after volume
// discounts, shipping, and the total, plus a one-line summary.

export function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function quote(text) {
  const items = parseOrder(text);
  const problems = validateOrder(items);
  if (problems.length) return { ok: false, problems };
  const subtotal = subtotalCents(items);
  const shipping = shippingCents(items, subtotal);
  const total = subtotal + shipping;
  return {
    ok: true,
    subtotal,
    shipping,
    total,
    summary: `${items.length} line${items.length === 1 ? '' : 's'}: ${money(subtotal)} + ${shipping ? money(shipping) : 'free'} shipping = ${money(total)}`,
  };
}
