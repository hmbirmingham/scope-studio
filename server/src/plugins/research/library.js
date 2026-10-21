import { copyFile, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ResearchError, htmlToText, normalizeDoi, terms } from './text.js';

// Reads a reference library into one plain shape, whichever form it came in:
//
//   { format, items: [Item], notes: [{ key, text }] }   (notes: standalone)
//   Item = { key, itemType, title, creators: [{ name, type }], year, doi,
//            abstract, citekey, publication,
//            attachments: [{ key, path, contentType }],
//            notes: [{ key, text }], relations: [itemKey] }
//
// Two forms are read: Zotero's own zotero.sqlite and a Better BibTeX JSON
// export. Neither is ever written to, and neither needs the network.

const MAX_LIBRARY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 200 * 1024 * 1024;
// Predicates whose object is another item of the library. Zotero's own
// "Related" is dc:relation (Zotero stores it on both items); cito:cites is
// what citation plug-ins record. Both become `cites` edges in the graph.
const RELATION_PREDICATES = new Set(['dc:relation', 'cito:cites']);
const ITEM_URI = /\/items\/([A-Z0-9]{8})$/;
const SKIP_TYPES = new Set(['note', 'attachment', 'annotation']);

function yearOf(date) {
  const match = String(date ?? '').match(/\b(1[5-9]\d\d|20\d\d|2100)\b/);
  return match ? Number(match[1]) : null;
}

function fromExtra(extra, label) {
  const match = String(extra ?? '').match(new RegExp(`^\\s*${label}\\s*:\\s*(\\S+)\\s*$`, 'im'));
  return match ? match[1] : null;
}

function asciiWord(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase();
}

// Better BibTeX's default key shape (auth.lower + year + shorttitle), used
// when the library records no key of its own, so the same paper gets the same
// key from either form of the library.
function generatedCitekey(item) {
  const author = asciiWord(item.creators.find((creator) => creator.type === 'author')?.family ?? item.creators[0]?.family ?? '') || 'anon';
  const word = asciiWord(terms(item.title ?? '', { max: 1 })[0] ?? '');
  return `${author}${item.year ?? ''}${word}`;
}

// Keys are unique within a library; a clash gets a, b, … as Better BibTeX does.
function assignCitekeys(items) {
  const used = new Set();
  for (const item of items) {
    const base = item.citekey || generatedCitekey(item);
    let key = base;
    for (let i = 0; used.has(key.toLowerCase()); i += 1) key = `${base}${String.fromCharCode(97 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`;
    used.add(key.toLowerCase());
    item.citekey = key;
  }
}

function finish(format, items, notes) {
  const keys = new Set(items.map((item) => item.key));
  for (const item of items) item.relations = [...new Set(item.relations)].filter((key) => key !== item.key && keys.has(key));
  assignCitekeys(items);
  // assignCitekeys reads `family`; it is not part of the shape.
  for (const item of items) for (const creator of item.creators) delete creator.family;
  return { format, items, notes };
}

function isPdf(path, contentType) {
  return contentType === 'application/pdf' || /\.pdf$/i.test(path ?? '');
}

// ---------------------------------------------------------------- zotero.sqlite

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// Zotero keeps its database open with an exclusive lock while it runs, so the
// file (and its write-ahead log, which holds the newest changes) is copied
// first and the copy is opened read-only.
async function openCopy(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new ResearchError('library_missing', `${path} is not a file`);
  if (info.size > MAX_LIBRARY_BYTES) throw new ResearchError('library_too_large', `${path} is larger than ${MAX_LIBRARY_BYTES} bytes`);
  const dir = await mkdtemp(join(tmpdir(), 'scope-zotero-'));
  const copy = join(dir, 'zotero.sqlite');
  await copyFile(path, copy);
  await copyFile(`${path}-wal`, `${copy}-wal`).catch(() => {});
  let db;
  try {
    db = new DatabaseSync(copy, { readOnly: true });
    db.prepare('SELECT count(*) FROM items').get();
  } catch (err) {
    db?.close();
    await rm(dir, { recursive: true, force: true });
    throw new ResearchError('library_unreadable', `${basename(path)} is not a Zotero database: ${err.message}`);
  }
  return {
    db,
    async close() {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function attachmentPath(path, { storageDir, attachmentKey }) {
  if (typeof path !== 'string' || !path) return null;
  if (path.startsWith('storage:')) {
    // A stored file lives in its attachment's own folder; a name that climbs
    // out of it (a hand-edited or hostile database) is not followed.
    const folder = resolve(storageDir, attachmentKey);
    const file = resolve(folder, path.slice('storage:'.length));
    return file.startsWith(`${folder}${sep}`) ? file : null;
  }
  // Linked files are stored as absolute paths. Paths relative to Zotero's
  // "linked attachment base directory" (attachments:…) depend on a preference
  // that lives outside the database, so they are reported, not guessed.
  return isAbsolute(path) ? path : null;
}

export async function readZoteroSqlite(path, { storageDir = join(dirname(path), 'storage') } = {}) {
  const { db, close } = await openCopy(path);
  try {
    const fields = hasTable(db, 'fieldsCombined') ? 'fieldsCombined' : 'fields';
    const types = hasTable(db, 'itemTypesCombined') ? 'itemTypesCombined' : 'itemTypes';
    const deleted = hasTable(db, 'deletedItems') ? 'AND i.itemID NOT IN (SELECT itemID FROM deletedItems)' : '';

    const rows = db.prepare(`SELECT i.itemID AS id, i.key, t.typeName AS type FROM items i JOIN ${types} t ON t.itemTypeID = i.itemTypeID WHERE 1 = 1 ${deleted} ORDER BY i.itemID`).all();
    const byId = new Map();
    const items = [];
    for (const row of rows) {
      if (SKIP_TYPES.has(row.type)) continue;
      const item = { key: row.key, itemType: row.type, title: null, creators: [], year: null, doi: null, abstract: null, citekey: null, publication: null, attachments: [], notes: [], relations: [], fields: {} };
      byId.set(row.id, item);
      items.push(item);
    }

    for (const row of db.prepare(`SELECT d.itemID AS id, f.fieldName AS name, v.value FROM itemData d JOIN ${fields} f ON f.fieldID = d.fieldID JOIN itemDataValues v ON v.valueID = d.valueID`).all()) {
      const item = byId.get(row.id);
      if (item) item.fields[row.name] = row.value == null ? null : String(row.value);
    }

    for (const row of db.prepare('SELECT ic.itemID AS id, c.firstName AS first, c.lastName AS last, c.fieldMode AS mode, ct.creatorType AS type FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID ORDER BY ic.itemID, ic.orderIndex').all()) {
      const item = byId.get(row.id);
      if (!item) continue;
      const single = row.mode === 1 || !row.first;
      item.creators.push({ name: single ? (row.last || row.first || '').trim() : `${row.first} ${row.last}`.trim(), type: row.type, family: single ? row.last || row.first : row.last });
    }

    const keyOf = new Map(db.prepare('SELECT itemID AS id, key FROM items').all().map((row) => [row.id, row.key]));
    const live = (id) => !deleted || !db.prepare('SELECT 1 FROM deletedItems WHERE itemID = ?').get(id);

    for (const row of db.prepare('SELECT a.itemID AS id, a.parentItemID AS parent, a.contentType, a.path FROM itemAttachments a ORDER BY a.itemID').all()) {
      const item = byId.get(row.parent);
      if (!item || !live(row.id) || !isPdf(row.path, row.contentType)) continue;
      const key = keyOf.get(row.id);
      item.attachments.push({ key, path: attachmentPath(row.path, { storageDir, attachmentKey: key }), stored: row.path, contentType: row.contentType ?? null });
    }

    const notes = [];
    for (const row of db.prepare('SELECT n.itemID AS id, n.parentItemID AS parent, n.note FROM itemNotes n ORDER BY n.itemID').all()) {
      if (!live(row.id)) continue;
      const text = htmlToText(row.note);
      if (!text) continue;
      const note = { key: keyOf.get(row.id), text };
      if (row.parent == null) notes.push(note);
      else byId.get(row.parent)?.notes.push(note);
    }

    if (hasTable(db, 'itemRelations') && hasTable(db, 'relationPredicates')) {
      for (const row of db.prepare('SELECT r.itemID AS id, p.predicate, r.object FROM itemRelations r JOIN relationPredicates p ON p.predicateID = r.predicateID').all()) {
        const match = RELATION_PREDICATES.has(row.predicate) ? String(row.object).match(ITEM_URI) : null;
        if (match) byId.get(row.id)?.relations.push(match[1]);
      }
    }

    for (const item of items) {
      const f = item.fields;
      item.title = f.title ?? null;
      item.abstract = f.abstractNote ?? null;
      item.year = yearOf(f.date);
      item.doi = normalizeDoi(f.DOI) ?? normalizeDoi(fromExtra(f.extra, 'DOI'));
      item.citekey = f.citationKey || fromExtra(f.extra, 'Citation Key');
      item.publication = f.publicationTitle ?? f.proceedingsTitle ?? f.bookTitle ?? null;
      delete item.fields;
    }
    return finish('zotero-sqlite', items, notes);
  } finally {
    await close();
  }
}

// ------------------------------------------------------- Better BibTeX JSON

function bbtCreators(creators) {
  return (Array.isArray(creators) ? creators : []).map((creator) => {
    const single = typeof creator?.name === 'string' && creator.name;
    const name = single ? creator.name : `${creator?.firstName ?? ''} ${creator?.lastName ?? ''}`.trim();
    return { name, type: creator?.creatorType ?? 'author', family: single ? creator.name : creator?.lastName ?? '' };
  });
}

function bbtNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .map((note, index) => ({ key: typeof note === 'object' ? note.key ?? note.itemKey ?? `N${index}` : `N${index}`, text: htmlToText(typeof note === 'string' ? note : note?.note) }))
    .filter((note) => note.text);
}

function bbtRelations(relations) {
  const out = [];
  for (const [predicate, objects] of Object.entries(relations ?? {})) {
    if (!RELATION_PREDICATES.has(predicate)) continue;
    for (const object of [objects].flat()) {
      const match = String(object).match(ITEM_URI);
      if (match) out.push(match[1]);
    }
  }
  return out;
}

export async function readBetterBibtexJson(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new ResearchError('library_missing', `${path} is not a file`);
  if (info.size > MAX_JSON_BYTES) throw new ResearchError('library_too_large', `${path} is larger than ${MAX_JSON_BYTES} bytes`);
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new ResearchError('library_unreadable', `${basename(path)} is not JSON: ${err.message}`);
  }
  if (!Array.isArray(data?.items)) throw new ResearchError('library_unreadable', `${basename(path)} is not a Better BibTeX JSON export (no items)`);

  const base = dirname(path);
  const items = [];
  const notes = [];
  for (const [index, entry] of data.items.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const key = String(entry.itemKey ?? entry.key ?? `ITEM${index}`);
    if (entry.itemType === 'note') {
      const text = htmlToText(entry.note);
      if (text) notes.push({ key, text });
      continue;
    }
    if (SKIP_TYPES.has(entry.itemType)) continue;
    const creators = bbtCreators(entry.creators);
    items.push({
      key,
      itemType: entry.itemType ?? 'document',
      title: entry.title ?? null,
      creators,
      year: yearOf(entry.date),
      doi: normalizeDoi(entry.DOI) ?? normalizeDoi(fromExtra(entry.extra, 'DOI')),
      abstract: entry.abstractNote ?? null,
      citekey: entry.citationKey || entry.citekey || fromExtra(entry.extra, 'Citation Key'),
      publication: entry.publicationTitle ?? entry.proceedingsTitle ?? entry.bookTitle ?? null,
      attachments: (Array.isArray(entry.attachments) ? entry.attachments : [])
        .filter((attachment) => typeof attachment?.path === 'string' && isPdf(attachment.path, attachment.contentType ?? attachment.mimeType))
        .map((attachment, i) => ({
          key: String(attachment.itemKey ?? attachment.key ?? `${key}-A${i}`),
          // Better BibTeX writes absolute paths; a relative one is taken
          // relative to the export, which keeps a moved export readable.
          path: isAbsolute(attachment.path) ? attachment.path : resolve(base, attachment.path),
          stored: attachment.path,
          contentType: attachment.contentType ?? attachment.mimeType ?? null,
        })),
      notes: bbtNotes(entry.notes),
      relations: bbtRelations(entry.relations),
    });
  }
  return finish('better-bibtex', items, notes);
}

// The reader for a library file, chosen by what the file is rather than what
// it is called: SQLite files start with a fixed 16-byte header.
export async function readLibrary(path, options = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new ResearchError('invalid_path', 'the library path must be absolute');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new ResearchError('library_missing', `${path} is not a file`);
  const header = Buffer.alloc(16);
  const handle = await open(path, 'r');
  try {
    await handle.read(header, 0, 16, 0);
  } finally {
    await handle.close();
  }
  const isSqlite = header.toString('latin1') === 'SQLite format 3\u0000';
  return isSqlite ? readZoteroSqlite(path, options) : readBetterBibtexJson(path);
}
