ALTER TABLE query_metrics
  ADD COLUMN session_id TEXT,
  ADD COLUMN tier TEXT,
  ADD COLUMN inferred_task_type TEXT,
  ADD COLUMN task_confidence REAL,
  ADD COLUMN superseded_nodes_demoted INTEGER,
  ADD COLUMN source_type_boost_applied INTEGER,
  ADD COLUMN user_confirmed_useful BOOLEAN,
  ADD COLUMN follow_up_within_60s BOOLEAN;

CREATE INDEX query_metrics_session_idx ON query_metrics (session_id, created_at);

CREATE TABLE query_context_nodes (
  query_id UUID NOT NULL REFERENCES query_metrics (query_id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  score REAL NOT NULL,
  decay_lambda REAL,
  PRIMARY KEY (query_id, node_id)
);

CREATE INDEX query_context_nodes_node_idx ON query_context_nodes (node_id);
