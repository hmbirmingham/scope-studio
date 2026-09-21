CREATE TABLE nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('repo', 'file', 'decision', 'spec', 'paper', 'datasheet', 'conversation')),
  content TEXT NOT NULL,
  embedding VECTOR(768),
  source TEXT CHECK (source IN ('github', 'notion', 'kicad', 'overleaf', 'zotero', 'manual')),
  project TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_count INTEGER NOT NULL DEFAULT 0,
  privacy TEXT NOT NULL DEFAULT 'cloud' CHECK (privacy IN ('local', 'cloud'))
);

CREATE INDEX nodes_project_idx ON nodes (project);
CREATE INDEX nodes_type_idx ON nodes (type);
CREATE INDEX nodes_embedding_idx ON nodes USING hnsw (embedding vector_cosine_ops);
