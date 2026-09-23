-- A project's working copy on this machine. Nodes come from a plugin, but
-- running anything needs a real directory, and only the user can say where.
CREATE TABLE project_settings (
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  local_path TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, project)
);
