import { getPool } from '../../db/pool.js';
import { inScope } from '../../workspace/permissions.js';
import { SOURCE } from './ingest.js';
import { ResearchError, normalizeDoi, normalizeText, terms as termsOf } from './text.js';

// Reads of the ingested library for the research capabilities and verifiers.
// Every read is limited to the owner and to the projects the agent may read
// (the runner asked can(read_graph) for source `zotero` on the run's project;
// a library ingested under another project is read only if that project is
// in the agent's read scope too).

const CANDIDATES = 400;

// The projects an agent may read library nodes from: null for all of them.
export function readableProjects(agent) {
  if (!agent) throw new ResearchError('no_agent', 'research capabilities run for an agent');
  const { projects, sources } = agent.scopes?.read ?? {};
  // The same rules as inReadScope: no list is no access, and the library is
  // read only by an agent whose read sources include it.
  if (!inScope(sources, SOURCE) || !Array.isArray(projects)) return [];
  if (projects.includes('*')) return null;
  return projects.filter((project) => typeof project === 'string');
}

function projectClause(projects, values) {
  if (projects == null) return 'TRUE';
  values.push(projects);
  return `n.project = ANY($${values.length}::text[])`;
}

const ITEM_COLUMNS = `n.id, n.type, n.project, n.privacy, r.kind, r.item_key, r.paper_node_id, r.citekey, r.doi, r.title,
  r.authors, r.year, r.page, r.chunk, r.text, r.attachments`;

function presentRow(row) {
  return {
    id: row.id,
    type: row.type,
    project: row.project,
    privacy: row.privacy,
    kind: row.kind,
    itemKey: row.item_key,
    paperId: row.kind === 'paper' ? row.id : row.paper_node_id,
    citekey: row.citekey,
    doi: row.doi,
    title: row.title,
    authors: row.authors ?? [],
    year: row.year,
    page: row.page,
    chunk: row.chunk,
    text: row.text ?? '',
    attachments: row.attachments ?? [],
    rank: row.rank == null ? 0 : Number(row.rank),
  };
}

// The words of a query as a Postgres full-text query over the same 'simple'
// configuration the nodes are indexed with (which also splits on . / _ -),
// each as a prefix so "transformer" finds "transformers".
export function tsQuery(words) {
  const parts = new Set();
  for (const word of words) {
    for (const part of word.split(/[./_-]+/)) if (/^[\p{L}\p{N}]{2,}$/u.test(part)) parts.add(`${part}:*`);
  }
  return [...parts].join(' | ');
}

// Library nodes (papers, notes, excerpts) matching any of the words, best
// full-text rank first.
export async function searchLibrary({ ownerId, projects, words, paperIds = null, limit = CANDIDATES, db = getPool() }) {
  const query = tsQuery(words);
  if (!query || (Array.isArray(projects) && projects.length === 0)) return [];
  const values = [ownerId, SOURCE, query];
  const scope = projectClause(projects, values);
  let papers = 'TRUE';
  if (paperIds) {
    values.push(paperIds);
    papers = `(r.paper_node_id = ANY($${values.length}::uuid[]) OR n.id = ANY($${values.length}::uuid[]))`;
  }
  values.push(limit);
  const { rows } = await db.query(
    `SELECT ${ITEM_COLUMNS}, ts_rank_cd(n.content_tsv, q) AS rank
       FROM nodes n JOIN research_items r ON r.node_id = n.id, to_tsquery('simple', $3) q
      WHERE n.owner_id = $1 AND n.source = $2 AND ${scope} AND ${papers} AND n.content_tsv @@ q
      ORDER BY rank DESC, n.id
      LIMIT $${values.length}`,
    values
  );
  return rows.map(presentRow);
}

export async function papersByIds({ ownerId, projects, ids, db = getPool() }) {
  if (ids.length === 0) return [];
  const values = [ownerId, ids];
  const scope = projectClause(projects, values);
  const { rows } = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM nodes n JOIN research_items r ON r.node_id = n.id
      WHERE n.owner_id = $1 AND n.id = ANY($2::uuid[]) AND r.kind = 'paper' AND ${scope}`,
    values
  );
  return rows.map(presentRow);
}

// Papers named by citekey (case-insensitive, as BibTeX keys compare), DOI or
// node id, in one query. Returns the matches; the caller decides what an
// unmatched reference means.
export async function findPapers({ ownerId, projects, citekeys = [], dois = [], ids = [], db = getPool() }) {
  const keys = [...new Set(citekeys.filter((k) => typeof k === 'string' && k).map((k) => k.toLowerCase()))];
  const normalized = [...new Set(dois.map(normalizeDoi).filter(Boolean))];
  const uuids = [...new Set(ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))];
  if (keys.length + normalized.length + uuids.length === 0) return [];
  const values = [ownerId, SOURCE, keys, normalized, uuids];
  const scope = projectClause(projects, values);
  const { rows } = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM nodes n JOIN research_items r ON r.node_id = n.id
      WHERE n.owner_id = $1 AND n.source = $2 AND r.kind = 'paper' AND ${scope}
        AND (lower(r.citekey) = ANY($3::text[]) OR r.doi = ANY($4::text[]) OR n.id = ANY($5::uuid[]))
      ORDER BY n.project, r.citekey`,
    values
  );
  return rows.map(presentRow);
}

// A paper's excerpts, in page order; `page` narrows them to one page.
export async function excerptsOf({ ownerId, paperId, page = null, db = getPool() }) {
  const values = [ownerId, paperId];
  let pageClause = '';
  if (page != null) {
    values.push(page);
    pageClause = `AND r.page = $${values.length}`;
  }
  const { rows } = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM nodes n JOIN research_items r ON r.node_id = n.id
      WHERE n.owner_id = $1 AND r.paper_node_id = $2 AND r.kind = 'excerpt' ${pageClause}
      ORDER BY r.page, r.chunk`,
    values
  );
  return rows.map(presentRow);
}

export async function excerptById({ ownerId, projects, id, db = getPool() }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) return null;
  const values = [ownerId, id];
  const scope = projectClause(projects, values);
  const { rows } = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM nodes n JOIN research_items r ON r.node_id = n.id
      WHERE n.owner_id = $1 AND n.id = $2 AND r.kind = 'excerpt' AND ${scope}`,
    values
  );
  return rows[0] ? presentRow(rows[0]) : null;
}

// Relevance of a text to a set of query words: the summed rarity (over the
// candidate set) of the words it contains. Deterministic, so the same graph
// and question always give the same ranking.
export function scorer(words, texts) {
  const lowered = texts.map((text) => normalizeText(text).toLowerCase());
  const df = new Map(words.map((word) => [word, lowered.filter((text) => text.includes(word)).length]));
  const n = Math.max(1, texts.length);
  const idf = (word) => Math.log(1 + n / Math.max(1, df.get(word)));
  return (text) => {
    const lower = normalizeText(text).toLowerCase();
    const matched = words.filter((word) => lower.includes(word));
    return { score: matched.reduce((sum, word) => sum + idf(word), 0), matched };
  };
}

export { termsOf };
