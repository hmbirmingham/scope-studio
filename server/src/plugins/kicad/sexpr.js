// A small reader for KiCad's S-expression files (.kicad_sch, .kicad_pcb,
// KiCad 6 and later). KiCad writes a plain subset: lists in parentheses,
// bare atoms and double-quoted strings with backslash escapes. A list becomes
// an array and an atom a string; the reader never evaluates anything.
//
// It is iterative rather than recursive, so a hostile file nested a million
// levels deep fails with a clear error instead of overflowing the stack.

export class KicadError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export const MAX_DEPTH = 256;

const ESCAPES = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };

function isDelimiter(ch) {
  return ch === '(' || ch === ')' || ch === '"' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\v';
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line += 1;
  return line;
}

// Parses one top-level list (what every KiCad file is) and returns it.
// Anything but whitespace after it is an error, so a truncated or
// concatenated file is reported rather than half read.
export function parseSexpr(text, { maxDepth = MAX_DEPTH } = {}) {
  if (typeof text !== 'string') throw new KicadError('parse_error', 'expected the file as text');
  const fail = (message, index) => {
    throw new KicadError('parse_error', `${message} (line ${lineAt(text, index)})`, { line: lineAt(text, index) });
  };
  const stack = [];
  let root = null;
  let i = 0;
  const n = text.length;
  // A UTF-8 byte order mark is harmless; skip it.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }
    if (ch === ')' && stack.length === 0) fail('unbalanced ")"', i);
    if (root !== null && stack.length === 0) fail('unexpected content after the end of the file', i);
    if (ch === '(') {
      if (stack.length >= maxDepth) fail(`lists are nested more than ${maxDepth} deep`, i);
      const list = [];
      if (stack.length > 0) stack[stack.length - 1].push(list);
      stack.push(list);
      i += 1;
      continue;
    }
    if (ch === ')') {
      const list = stack.pop();
      if (stack.length === 0) root = list;
      i += 1;
      continue;
    }
    if (stack.length === 0) fail('expected "("', i);
    if (ch === '"') {
      let value = '';
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === '\\' && j + 1 < n) {
          const next = text[j + 1];
          value += ESCAPES[next] ?? next;
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          break;
        }
        value += c;
        j += 1;
      }
      if (!closed) fail('unterminated string', i);
      stack[stack.length - 1].push(value);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !isDelimiter(text[j])) j += 1;
    stack[stack.length - 1].push(text.slice(i, j));
    i = j;
  }
  if (stack.length > 0) fail('unexpected end of file: a list was never closed', n);
  if (root === null) fail('the file is empty', 0);
  return root;
}

// Helpers over parsed lists. `head` is a list's first atom (its keyword).
export const head = (node) => (Array.isArray(node) && typeof node[0] === 'string' ? node[0] : null);
export const children = (node, name) => (Array.isArray(node) ? node.filter((child) => head(child) === name) : []);
export const child = (node, name) => (Array.isArray(node) ? node.find((child) => head(child) === name) ?? null : null);

// The first atom after the keyword of a named child: `(layer "F.Cu")` → "F.Cu".
export function atom(node, name, index = 1) {
  const found = child(node, name);
  const value = found?.[index];
  return typeof value === 'string' ? value : null;
}

export function num(value, fallback = 0) {
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

// `(at x y angle?)` → { x, y, angle }.
export function position(node) {
  const at = child(node, 'at');
  if (!at) return null;
  return { x: num(at[1]), y: num(at[2]), angle: num(at[3], 0) };
}

// KiCad 8 writes flags as `(hide yes)`; KiCad 6 and 7 wrote a bare `hide`.
// Either form, or `(name no)`, is understood.
export function flag(node, name, fallback = false) {
  if (!Array.isArray(node)) return fallback;
  if (node.slice(1).includes(name)) return true;
  const found = child(node, name);
  if (!found) return fallback;
  if (found.length === 1) return true;
  return found[1] === 'yes' || found[1] === 'true';
}

// Every `(property "Name" "Value" …)` of a symbol or footprint, in order.
export function properties(node) {
  const props = {};
  for (const prop of children(node, 'property')) {
    if (typeof prop[1] === 'string' && typeof prop[2] === 'string' && !(prop[1] in props)) props[prop[1]] = prop[2];
  }
  return props;
}
