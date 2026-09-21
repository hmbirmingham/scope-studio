CREATE TABLE node_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('depends_on', 'references', 'supersedes', 'caused_by', 'part_of')),
  weight REAL NOT NULL DEFAULT 1.0,
  UNIQUE (source_id, target_id, type)
);

CREATE INDEX node_relationships_source_idx ON node_relationships (source_id);
CREATE INDEX node_relationships_target_idx ON node_relationships (target_id);
