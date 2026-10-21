import { totalGrams } from './weight.js';

// Shipping is banded by parcel weight in kilograms; orders at or above the
// free-shipping threshold ship free whatever they weigh.

export const FREE_SHIPPING_CENTS = 15_000;

export const BANDS = [
  { maxKg: 1, cents: 495 },
  { maxKg: 5, cents: 895 },
  { maxKg: 20, cents: 1_895 },
];
export const OVERWEIGHT_CENTS_PER_KG = 120;

export function bandCents(kg) {
  const band = BANDS.find((entry) => kg <= entry.maxKg);
  if (band) return band.cents;
  const last = BANDS.at(-1);
  return last.cents + Math.ceil(kg - last.maxKg) * OVERWEIGHT_CENTS_PER_KG;
}

export function shippingCents(items, subtotal) {
  if (subtotal >= FREE_SHIPPING_CENTS) return 0;
  const kg = totalGrams(items);
  return bandCents(kg);
}
