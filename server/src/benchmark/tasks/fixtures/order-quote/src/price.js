// Item pricing. Volume discounts apply per line, by quantity, and amounts
// stay in cents throughout.

export const VOLUME_TIERS = [
  { minQuantity: 100, rate: 0.15 },
  { minQuantity: 25, rate: 0.1 },
  { minQuantity: 10, rate: 0.05 },
];

export function volumeRate(quantity) {
  return VOLUME_TIERS.find((tier) => quantity >= tier.minQuantity)?.rate ?? 0;
}

export function lineCents(item) {
  return Math.round(item.unitCents * item.quantity * (1 - volumeRate(item.quantity)));
}

export function subtotalCents(items) {
  return items.reduce((sum, item) => sum + lineCents(item), 0);
}
