import { getPool } from '../../db/pool.js';
import { tryEmbedDocuments } from '../../lib/embeddings.js';
import { readLibrary } from './library.js';
import { defaultPdfText } from './pdf.js';
import { ResearchError, chunkPages } from './text.js';

// Library → graph. Papers become `paper` nodes, notes `note` nodes, each PDF
// page's text `excerpt` nodes `part_of` their paper, and related items `cites`
// edges between papers. Every node carries the owner, the project the library
// was ingested as, a stable external id (so ingesting again updates rather
// than duplicates) and the privacy the user chose for the library. Nothing
// here touches the network except the local embedding model, and ingest does
// not fail without it: missing embeddings are backfilled by `npm run embed`.

export const SOURCE = 'zotero';
export const PRIVACY = ['local', 'cloud'];
const MAX_WARNINGS = 20;

const ids = {
  paper: (project, key) => `${project}/item/${key}`,
  note: (project, key) => `${project}/note/${key}`,
  excerptPrefix: (project, key) => `${project}/item/${key}/pdf/`,
  excerpt: (project, key, attachment, page, chunk) => `${project}/item/${key}/pdf/${attachment}/p${page}c${chunk}`,
};

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function authorList(creators) {
  const authors = creators.filter((creator) => creator.type === 'author');
  return (authors.length > 0 ? authors : creators).map((creator) => creator.name).filter(Boolean);
}

function paperContent(item) {
  const authors = authorList(item.creators);
  const byline = [authors.join(', '), item.year ? `(${item.year})` : null, item.publication].filter(Boolean).join(' ');
  const ids = [`@${item.citekey}`, item.doi ? `DOI ${item.doi}` : null].filter(Boolean).join(' · ');
  return [item.title ?? '(untitled)', byline, ids, item.abstract].filter(Boolean).join('\n');
}

const excerptContent = (item, chunk) => `[@${item.citekey}, p. ${chunk.page}] ${chunk.text}`;
const noteContent = (item, note) => (item ? `Note on @${item.citekey} (${item.title ?? 'untitled'}): ${note.text}` : `Note: ${note.text}`);

async function upsertNode(client, { ownerId, type, content, embedding, externalId, project, privacy }) {
  const { rows } = await client.query(
    `INSERT INTO nodes (owner_id, type, content, embedding, source, external_id, project, privacy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (owner_id, source, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET type = EXCLUDED.type, content = EXCLUDED.content,
       embedding = COALESCE(EXCLUDED.embedding, nodes.embedding),
       project = EXCLUDED.project, privacy = EXCLUDED.privacy
     RETURNING id`,
    [ownerId, type, content, embedding ? `[${embedding.join(',')}]` : null, SOURCE, externalId, project, privacy]
  );
  return rows[0].id;
}

async function upsertItem(client, nodeId, ownerId, fields) {
  await client.query(
    `INSERT INTO research_items (node_id, owner_id, kind, item_key, paper_node_id, citekey, doi, title, authors, year, page, chunk, text, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (node_id) DO UPDATE SET kind = EXCLUDED.kind, item_key = EXCLUDED.item_key, paper_node_id = EXCLUDED.paper_node_id,
       citekey = EXCLUDED.citekey, doi = EXCLUDED.doi, title = EXCLUDED.title, authors = EXCLUDED.authors, year = EXCLUDED.year,
       page = EXCLUDED.page, chunk = EXCLUDED.chunk, text = EXCLUDED.text, attachments = EXCLUDED.attachments`,
    [
      nodeId, ownerId, fields.kind, fields.itemKey, fields.paperNodeId ?? null, fields.citekey ?? null, fields.doi ?? null, fields.title ?? null,
      JSON.stringify(fields.authors ?? []), fields.year ?? null, fields.page ?? null, fields.chunk ?? null, fields.text ?? null, JSON.stringify(fields.attachments ?? []),
    ]
  );
}

async function link(client, sourceId, targetId, type) {
  await client.query(
    'INSERT INTO node_relationships (source_id, target_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [sourceId, targetId, type]
  );
}

// The text of an item's PDFs, page by page, or why there is none. A missing
// file or an unreadable PDF is a warning on that item, never a failed ingest.
async function readPdfs(item, pdf, available, summary, warn) {
  const out = [];
  for (const attachment of item.attachments) {
    if (!attachment.path) {
      warn(`@${item.citekey}: attachment ${attachment.stored} has no resolvable path`);
      summary.pdfs.missing += 1;
      continue;
    }
    if (!available) {
      summary.pdfs.unavailable += 1;
      continue;
    }
    try {
      out.push({ attachment, pages: await pdf.pages(attachment.path) });
      summary.pdfs.read += 1;
    } catch (err) {
      if (err.code === 'pdf_missing') summary.pdfs.missing += 1;
      else summary.pdfs.failed += 1;
      warn(`@${item.citekey}: ${err.message}`);
    }
  }
  return out;
}

export async function ingestLibrary({
  ownerId,
  path,
  project = 'zotero',
  privacy = 'local',
  storageDir,
  pdf = defaultPdfText,
  embed = tryEmbedDocuments,
  onProgress,
  db = getPool(),
}) {
  if (!ownerId) throw new ResearchError('invalid_input', 'an owner is required');
  if (typeof project !== 'string' || !project.trim() || project.length > 200) throw new ResearchError('invalid_input', 'project must be a non-empty name of at most 200 characters');
  if (!PRIVACY.includes(privacy)) throw new ResearchError('invalid_input', `privacy must be one of ${PRIVACY.join(', ')}`);

  const library = await readLibrary(path, storageDir ? { storageDir } : {});
  const pdfState = await pdf.status();
  const summary = {
    format: library.format,
    project,
    privacy,
    papers: 0,
    notes: 0,
    excerpts: 0,
    cites: 0,
    pruned: 0,
    pdfs: { read: 0, missing: 0, failed: 0, unavailable: 0, tool: pdfState.available ? { available: true, version: pdfState.version } : { available: false, reason: pdfState.reason } },
    warnings: [],
  };
  const warn = (message) => {
    if (summary.warnings.length < MAX_WARNINGS) summary.warnings.push(message);
  };
  if (!pdfState.available && library.items.some((item) => item.attachments.length > 0)) {
    warn(`PDF text was not extracted: ${pdfState.reason}. Papers and notes were ingested; ingest again once pdftotext is installed.`);
  }

  const seen = [];
  // Excerpts of a paper whose PDF could not be read this time are kept from
  // the last ingest rather than pruned, so a missing tool loses nothing.
  const keepPrefixes = [];
  const paperIds = new Map();
  const embedOne = async (texts) => {
    const vectors = await embed(texts);
    return Array.isArray(vectors) ? vectors : texts.map(() => null);
  };

  for (const [index, item] of library.items.entries()) {
    onProgress?.({ item: item.citekey, itemsDone: index, itemsTotal: library.items.length, excerpts: summary.excerpts });
    const pdfs = await readPdfs(item, pdf, pdfState.available, summary, warn);
    if (pdfs.length < item.attachments.length) keepPrefixes.push(`${escapeLike(ids.excerptPrefix(project, item.key))}%`);

    const chunks = pdfs.flatMap(({ attachment, pages }) => chunkPages(pages).map((chunk) => ({ ...chunk, attachment: attachment.key })));
    const paper = { content: paperContent(item), externalId: ids.paper(project, item.key) };
    const notes = item.notes.map((note) => ({ content: noteContent(item, note), externalId: ids.note(project, note.key), note }));
    const excerpts = chunks.map((chunk) => ({ content: excerptContent(item, chunk), externalId: ids.excerpt(project, item.key, chunk.attachment, chunk.page, chunk.chunk), chunk }));
    const vectors = await embedOne([paper.content, ...notes.map((n) => n.content), ...excerpts.map((e) => e.content)]);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const paperId = await upsertNode(client, { ownerId, type: 'paper', content: paper.content, embedding: vectors[0], externalId: paper.externalId, project, privacy });
      await upsertItem(client, paperId, ownerId, {
        kind: 'paper',
        itemKey: item.key,
        citekey: item.citekey,
        doi: item.doi,
        title: item.title,
        authors: authorList(item.creators),
        year: item.year,
        text: item.abstract,
        attachments: item.attachments.map((a) => ({ key: a.key, path: a.path, contentType: a.contentType })),
      });
      seen.push(paper.externalId);
      for (const [i, note] of notes.entries()) {
        const id = await upsertNode(client, { ownerId, type: 'note', content: note.content, embedding: vectors[1 + i], externalId: note.externalId, project, privacy });
        await upsertItem(client, id, ownerId, { kind: 'note', itemKey: note.note.key, paperNodeId: paperId, citekey: item.citekey, text: note.note.text });
        await link(client, id, paperId, 'part_of');
        seen.push(note.externalId);
      }
      for (const [i, excerpt] of excerpts.entries()) {
        const id = await upsertNode(client, { ownerId, type: 'excerpt', content: excerpt.content, embedding: vectors[1 + notes.length + i], externalId: excerpt.externalId, project, privacy });
        await upsertItem(client, id, ownerId, { kind: 'excerpt', itemKey: item.key, paperNodeId: paperId, citekey: item.citekey, page: excerpt.chunk.page, chunk: excerpt.chunk.chunk, text: excerpt.chunk.text });
        await link(client, id, paperId, 'part_of');
        seen.push(excerpt.externalId);
      }
      await client.query('COMMIT');
      paperIds.set(item.key, paperId);
      summary.papers += 1;
      summary.notes += notes.length;
      summary.excerpts += excerpts.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Edges only once every paper exists, so a relation to a later item links.
  // A paper's cites edges are replaced, so a relation removed in the library
  // goes from the graph too.
  for (const item of library.items) {
    const from = paperIds.get(item.key);
    const targets = item.relations.map((key) => paperIds.get(key)).filter(Boolean);
    await db.query(
      `DELETE FROM node_relationships r USING nodes t
        WHERE r.source_id = $1 AND r.type = 'cites' AND t.id = r.target_id AND t.source = $2 AND NOT (r.target_id = ANY($3::uuid[]))`,
      [from, SOURCE, targets]
    );
    for (const to of targets) {
      await link(db, from, to, 'cites');
      summary.cites += 1;
    }
  }

  for (const note of library.notes) {
    const content = noteContent(null, note);
    const [vector] = await embedOne([content]);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const id = await upsertNode(client, { ownerId, type: 'note', content, embedding: vector, externalId: ids.note(project, note.key), project, privacy });
      await upsertItem(client, id, ownerId, { kind: 'note', itemKey: note.key, text: note.text });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    seen.push(ids.note(project, note.key));
    summary.notes += 1;
  }

  // Whatever this library no longer holds (an item deleted or trashed in
  // Zotero, a PDF that changed) leaves the graph.
  const { rowCount } = await db.query(
    `DELETE FROM nodes
      WHERE owner_id = $1 AND source = $2 AND project = $3 AND external_id IS NOT NULL
        AND NOT (external_id = ANY($4::text[])) AND NOT (external_id LIKE ANY($5::text[]))`,
    [ownerId, SOURCE, project, seen, keepPrefixes]
  );
  summary.pruned = rowCount;
  onProgress?.({ item: null, itemsDone: library.items.length, itemsTotal: library.items.length, excerpts: summary.excerpts });
  return summary;
}
