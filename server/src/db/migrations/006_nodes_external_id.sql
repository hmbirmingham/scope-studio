ALTER TABLE nodes ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX nodes_source_external_id_idx
  ON nodes (source, external_id)
  WHERE external_id IS NOT NULL;
