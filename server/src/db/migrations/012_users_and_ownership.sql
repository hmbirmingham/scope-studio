CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schema expected by connect-pg-simple.
CREATE TABLE session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);

ALTER TABLE nodes ADD COLUMN owner_id UUID REFERENCES users (id) ON DELETE CASCADE;
CREATE INDEX nodes_owner_idx ON nodes (owner_id);

-- Ingested artifacts are unique per owner, not globally: two users may connect the same repo.
DROP INDEX nodes_source_external_id_idx;
CREATE UNIQUE INDEX nodes_owner_source_external_id_idx
  ON nodes (owner_id, source, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE query_metrics ADD COLUMN owner_id UUID REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX query_metrics_owner_idx ON query_metrics (owner_id, created_at);
