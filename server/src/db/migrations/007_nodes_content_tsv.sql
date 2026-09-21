ALTER TABLE nodes ADD COLUMN content_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

CREATE INDEX nodes_content_tsv_idx ON nodes USING gin (content_tsv);
