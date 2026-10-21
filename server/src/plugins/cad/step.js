import { CadError } from './errors.js';

// STEP (ISO 10303-21) read in JavaScript as far as the product structure:
// the header, the products, which assembly uses which part (and how many
// times), the declared length unit and how many solids the file holds.
// Geometry (volume, interference) needs a real B-rep kernel and comes from
// CadQuery in the sandbox when it is installed (cadquery.js).

export const MAX_STEP_BYTES = 64 * 1024 * 1024;
const MAX_ENTITIES = 2_000_000;

// A parameter list as values: strings, numbers, references ({ ref }),
// enumerations ({ enum }), $ (null), * (derived), nested lists and typed
// values ({ type, params }).
function parseParams(text, start) {
  const values = [];
  let i = start;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  for (;;) {
    skip();
    const ch = text[i];
    if (ch === undefined) throw new CadError('invalid_step', 'unterminated parameter list');
    if (ch === ')') return { values, end: i + 1 };
    if (ch === ',') {
      i += 1;
      continue;
    }
    if (ch === "'") {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= text.length) throw new CadError('invalid_step', 'unterminated string');
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      values.push(value);
    } else if (ch === '(') {
      const inner = parseParams(text, i + 1);
      values.push(inner.values);
      i = inner.end;
    } else if (ch === '#') {
      const match = /^#(\d+)/.exec(text.slice(i, i + 24));
      if (!match) throw new CadError('invalid_step', 'malformed reference');
      values.push({ ref: Number(match[1]) });
      i += match[0].length;
    } else if (ch === '.') {
      const end = text.indexOf('.', i + 1);
      if (end === -1) throw new CadError('invalid_step', 'malformed enumeration');
      values.push({ enum: text.slice(i + 1, end) });
      i = end + 1;
    } else if (ch === '$') {
      values.push(null);
      i += 1;
    } else if (ch === '*') {
      values.push({ derived: true });
      i += 1;
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      values.push({ binary: text.slice(i + 1, end) });
      i = end + 1;
    } else {
      const number = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
      if (number) {
        values.push(Number(number[0]));
        i += number[0].length;
        continue;
      }
      const keyword = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 128));
      if (!keyword) throw new CadError('invalid_step', `unexpected character ${JSON.stringify(ch)} in a parameter list`);
      i += keyword[0].length;
      skip();
      if (text[i] !== '(') throw new CadError('invalid_step', `typed value ${keyword[0]} has no parameters`);
      const inner = parseParams(text, i + 1);
      values.push({ type: keyword[0].toUpperCase(), params: inner.values });
      i = inner.end;
    }
  }
}

// Statements end at a semicolon outside strings and comments; comments are
// dropped as the text is split.
function statements(source) {
  const list = [];
  let current = '';
  let from = 0;
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === "'") {
        if (source[i + 1] === "'") i += 1;
        else inString = false;
      }
    } else if (ch === "'") {
      inString = true;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new CadError('invalid_step', 'unterminated comment');
      current += source.slice(from, i);
      i = end + 1;
      from = end + 2;
    } else if (ch === ';') {
      const statement = (current + source.slice(from, i)).trim();
      if (statement) list.push(statement);
      current = '';
      from = i + 1;
    }
  }
  return list;
}

// One record, `NAME(params)`, or a complex instance `(A(..) B(..))`.
function parseRecord(body) {
  body = body.trim();
  if (body.startsWith('(')) {
    const parts = [];
    let i = 1;
    for (;;) {
      while (/\s/.test(body[i] ?? '')) i += 1;
      if (body[i] === ')' || i >= body.length) break;
      const keyword = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i, i + 128));
      if (!keyword) throw new CadError('invalid_step', 'malformed complex instance');
      i += keyword[0].length;
      while (/\s/.test(body[i] ?? '')) i += 1;
      const inner = parseParams(body, i + 1);
      parts.push({ type: keyword[0].toUpperCase(), params: inner.values });
      i = inner.end;
    }
    return { type: null, params: [], parts };
  }
  const keyword = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(body);
  if (!keyword) throw new CadError('invalid_step', `malformed record: ${body.slice(0, 60)}`);
  const { values } = parseParams(body, keyword[0].length);
  return { type: keyword[1].toUpperCase(), params: values, parts: null };
}

const refOf = (value) => (value && typeof value === 'object' && 'ref' in value ? value.ref : null);
const text = (value) => (typeof value === 'string' ? value : null);

function lengthUnitOf(entities) {
  for (const entity of entities.values()) {
    const parts = entity.parts;
    if (!parts?.some((part) => part.type === 'LENGTH_UNIT')) continue;
    const si = parts.find((part) => part.type === 'SI_UNIT');
    if (si) {
      const prefix = si.params[0]?.enum ?? null;
      const name = si.params[1]?.enum ?? null;
      if (name === 'METRE') return { MILLI: 'mm', CENTI: 'cm', MICRO: 'um' }[prefix] ?? (prefix ? `${prefix.toLowerCase()}metre` : 'm');
    }
    const converted = parts.find((part) => part.type === 'CONVERSION_BASED_UNIT');
    if (converted) {
      const name = String(converted.params[0] ?? '').toLowerCase();
      if (name.startsWith('inch')) return 'in';
      if (name.startsWith('foot') || name.startsWith('feet')) return 'ft';
      return name || null;
    }
  }
  return null;
}

export function parseStep(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length > MAX_STEP_BYTES) throw new CadError('file_too_large', `STEP files are limited to ${MAX_STEP_BYTES} bytes`);
  const source = buffer.toString('latin1');
  if (!/^\s*ISO-10303-21\s*;/.test(source)) throw new CadError('invalid_step', 'a STEP file starts with ISO-10303-21;');

  const header = { description: null, fileName: null, timestamp: null, authors: [], organizations: [], preprocessor: null, originatingSystem: null, schemas: [] };
  const entities = new Map();
  let section = null;
  for (const statement of statements(source)) {
    const word = statement.toUpperCase();
    if (word === 'HEADER' || word === 'DATA' || word.startsWith('DATA(') || word.startsWith('DATA (')) {
      section = word === 'HEADER' ? 'header' : 'data';
      continue;
    }
    if (word === 'ENDSEC' || word === 'ISO-10303-21' || word === 'END-ISO-10303-21') {
      if (word === 'ENDSEC') section = null;
      continue;
    }
    if (section === 'header') {
      const record = parseRecord(statement);
      if (record.type === 'FILE_DESCRIPTION') header.description = (record.params[0] ?? []).filter((v) => typeof v === 'string').join(' ') || null;
      if (record.type === 'FILE_NAME') {
        header.fileName = text(record.params[0]);
        header.timestamp = text(record.params[1]);
        header.authors = (record.params[2] ?? []).filter((v) => typeof v === 'string' && v);
        header.organizations = (record.params[3] ?? []).filter((v) => typeof v === 'string' && v);
        header.preprocessor = text(record.params[4]);
        header.originatingSystem = text(record.params[5]);
      }
      if (record.type === 'FILE_SCHEMA') header.schemas = (record.params[0] ?? []).filter((v) => typeof v === 'string');
    } else if (section === 'data') {
      const match = /^#(\d+)\s*=\s*([\s\S]*)$/.exec(statement);
      if (!match) throw new CadError('invalid_step', `malformed entity: ${statement.slice(0, 60)}`);
      entities.set(Number(match[1]), parseRecord(match[2]));
      if (entities.size > MAX_ENTITIES) throw new CadError('file_too_large', `the file has more than ${MAX_ENTITIES} entities`);
    }
  }
  if (entities.size === 0) throw new CadError('invalid_step', 'the file has no DATA section entities');
  return { header, entities };
}

const FORMATIONS = new Set(['PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE']);
const DEFINITIONS = new Set(['PRODUCT_DEFINITION', 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS']);
const SOLIDS = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP']);

// Products as a tree: each product with whether it is an assembly (it uses
// other products) and the products it contains with their quantities.
export function productStructure({ header, entities }) {
  const products = new Map();
  const formationToProduct = new Map();
  const definitionToProduct = new Map();
  const counts = { solids: 0, faces: 0, entities: entities.size };

  for (const [id, entity] of entities) {
    const type = entity.type;
    if (type === 'PRODUCT') {
      products.set(id, { stepId: id, id: text(entity.params[0]) ?? `#${id}`, name: text(entity.params[1]) || text(entity.params[0]) || `#${id}`, description: text(entity.params[2]), children: new Map(), parents: 0 });
    } else if (FORMATIONS.has(type)) {
      formationToProduct.set(id, refOf(entity.params[2]));
    } else if (SOLIDS.has(type)) counts.solids += 1;
    else if (type === 'ADVANCED_FACE' || type === 'FACE_SURFACE') counts.faces += 1;
  }
  for (const [id, entity] of entities) {
    if (DEFINITIONS.has(entity.type)) definitionToProduct.set(id, formationToProduct.get(refOf(entity.params[2])) ?? null);
  }
  const usages = [];
  for (const entity of entities.values()) {
    if (entity.type !== 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') continue;
    const parent = products.get(definitionToProduct.get(refOf(entity.params[3])));
    const child = products.get(definitionToProduct.get(refOf(entity.params[4])));
    if (!parent || !child || parent === child) continue;
    parent.children.set(child.stepId, (parent.children.get(child.stepId) ?? 0) + 1);
    child.parents += 1;
    usages.push({ parent: parent.id, child: child.id, name: text(entity.params[1]) ?? text(entity.params[0]) });
  }

  const list = [...products.values()].map((product) => ({
    id: product.id,
    name: product.name,
    description: product.description,
    kind: product.children.size > 0 ? 'assembly' : 'part',
    root: product.parents === 0,
    contains: [...product.children].map(([stepId, quantity]) => ({ id: products.get(stepId).id, name: products.get(stepId).name, quantity })),
  }));
  return {
    header,
    lengthUnit: lengthUnitOf(entities),
    products: list,
    usages,
    counts,
  };
}

export function readStep(buffer) {
  return productStructure(parseStep(buffer));
}
