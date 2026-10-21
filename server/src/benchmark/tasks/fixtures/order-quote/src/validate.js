// Business rules an order must meet before it can be quoted.

export const MAX_LINES = 50;
export const MAX_QUANTITY = 999;

export function validateOrder(items) {
  const problems = [];
  if (items.length === 0) problems.push('the order is empty');
  if (items.length > MAX_LINES) problems.push(`an order holds at most ${MAX_LINES} lines`);
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.sku)) problems.push(`${item.sku} appears twice; merge the lines`);
    seen.add(item.sku);
    if (item.quantity === 0) problems.push(`${item.sku} has quantity 0`);
    if (item.quantity > MAX_QUANTITY) problems.push(`${item.sku} exceeds ${MAX_QUANTITY} units`);
  }
  return problems;
}
