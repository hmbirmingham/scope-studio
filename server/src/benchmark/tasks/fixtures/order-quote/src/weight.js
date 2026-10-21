// Parcel weight. Items carry their weight in grams; packaging adds a fixed
// amount per parcel.

export const PACKAGING_GRAMS = 250;

export function totalGrams(items) {
  return items.reduce((sum, item) => sum + item.gramsEach * item.quantity, 0) + PACKAGING_GRAMS;
}
