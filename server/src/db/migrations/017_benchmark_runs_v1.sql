-- The benchmark measures retrieval, not answers: whether the relevant nodes
-- reach the pack, where they rank, and what they cost. One row per
-- configuration per run, with per-query detail kept for later comparison.
ALTER TABLE benchmark_runs
  ADD COLUMN label TEXT,
  ADD COLUMN owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN tier TEXT,
  ADD COLUMN config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN query_set TEXT,
  ADD COLUMN hit_rate REAL,
  ADD COLUMN candidate_hit_rate REAL,
  ADD COLUMN mean_recall REAL,
  ADD COLUMN mean_mrr REAL,
  ADD COLUMN mean_retrieval_ms REAL,
  ADD COLUMN mean_tokens_injected REAL,
  ADD COLUMN results JSONB;
