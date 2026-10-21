-- What the research plug-in knows about a library node beyond its text: the
-- bibliographic fields citations resolve against (citekey, DOI), and for an
-- excerpt the page it comes from and its exact text, which quotes are checked
-- against. One row per paper, note or excerpt node; it goes when the node
-- goes, and with its owner.
CREATE TABLE research_items (
  node_id UUID PRIMARY KEY REFERENCES nodes (id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('paper', 'note', 'excerpt')),
  -- The library's own key for the item (Zotero's 8-character key).
  item_key TEXT NOT NULL,
  -- For a note or an excerpt, the paper it belongs to.
  paper_node_id UUID REFERENCES nodes (id) ON DELETE CASCADE,
  citekey TEXT,
  doi TEXT,
  title TEXT,
  authors JSONB NOT NULL DEFAULT '[]',
  year INTEGER,
  page INTEGER CHECK (page IS NULL OR page > 0),
  chunk INTEGER,
  text TEXT,
  attachments JSONB NOT NULL DEFAULT '[]',
  CHECK (kind <> 'excerpt' OR (paper_node_id IS NOT NULL AND page IS NOT NULL AND text IS NOT NULL))
);

CREATE INDEX research_items_citekey_idx ON research_items (owner_id, lower(citekey)) WHERE kind = 'paper';
CREATE INDEX research_items_doi_idx ON research_items (owner_id, doi) WHERE kind = 'paper';
CREATE INDEX research_items_paper_idx ON research_items (paper_node_id, page);
