-- Postgres parses `owner/repo`, `path/file.js`, and `snake_case` as single
-- tokens; splitting them first makes each component lexically searchable.
ALTER TABLE nodes DROP COLUMN content_tsv;

ALTER TABLE nodes ADD COLUMN content_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(content, '[/._-]+', ' ', 'g'))) STORED;

CREATE INDEX nodes_content_tsv_idx ON nodes USING gin (content_tsv);
