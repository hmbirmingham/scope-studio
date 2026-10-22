import { CadError } from './errors.js';

// Length and density units the CAD plug-in understands. A mesh carries no
// units of its own (STL has none), so the project declares the unit its
// files are drawn in, and every quantity reported says which unit it is in.

// Metres per unit.
export const LENGTH_UNITS = Object.freeze({
  um: 1e-6,
  mm: 1e-3,
  cm: 1e-2,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
});

// kg/m³ per unit.
export const DENSITY_UNITS = Object.freeze({
  'kg/m3': 1,
  'g/cm3': 1000,
  'g/mm3': 1e6,
  'kg/mm3': 1e9,
  'lb/in3': 27679.9047102,
  'lb/ft3': 16.0184634,
});

const ALIASES = {
  millimetre: 'mm', millimeter: 'mm', millimetres: 'mm', millimeters: 'mm',
  centimetre: 'cm', centimeter: 'cm',
  metre: 'm', meter: 'm', metres: 'm', meters: 'm',
  micron: 'um', 'µm': 'um',
  inch: 'in', inches: 'in',
  foot: 'ft', feet: 'ft',
  'kg/m^3': 'kg/m3', 'kg/m³': 'kg/m3',
  'g/cm^3': 'g/cm3', 'g/cm³': 'g/cm3', 'g/cc': 'g/cm3',
  'g/mm^3': 'g/mm3', 'g/mm³': 'g/mm3',
  'kg/mm^3': 'kg/mm3', 'kg/mm³': 'kg/mm3',
  'lb/in^3': 'lb/in3', 'lb/in³': 'lb/in3',
  'lb/ft^3': 'lb/ft3', 'lb/ft³': 'lb/ft3',
};

function canonical(unit) {
  if (typeof unit !== 'string') return null;
  const key = unit.trim();
  return ALIASES[key.toLowerCase()] ?? ALIASES[key] ?? key;
}

export function lengthUnit(unit, { label = 'units' } = {}) {
  const key = canonical(unit);
  if (!key || !(key in LENGTH_UNITS)) {
    throw new CadError('invalid_units', `${label} must be one of ${Object.keys(LENGTH_UNITS).join(', ')}`);
  }
  return key;
}

// `{ value, unit }` → kg/m³. A density must be a positive, finite number.
export function densityToSi(density) {
  if (density == null || typeof density !== 'object') throw new CadError('invalid_input', 'density must be { value, unit }');
  const unit = canonical(density.unit);
  if (!unit || !(unit in DENSITY_UNITS)) {
    throw new CadError('invalid_units', `density unit must be one of ${Object.keys(DENSITY_UNITS).join(', ')}`);
  }
  if (typeof density.value !== 'number' || !Number.isFinite(density.value) || density.value <= 0) {
    throw new CadError('invalid_input', 'density value must be a positive number');
  }
  return { kgPerM3: density.value * DENSITY_UNITS[unit], unit };
}

export function metresPer(unit) {
  return LENGTH_UNITS[lengthUnit(unit)];
}

// Converts a length between units.
export function convertLength(value, from, to) {
  return (value * metresPer(from)) / metresPer(to);
}

// Rounds for display without losing what a tolerance check needs: twelve
// significant digits is far below any drawing's precision and far above
// floating-point noise.
export function round(value, digits = 12) {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(digits));
}
