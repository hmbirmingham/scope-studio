CREATE TABLE benchmark_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_hash TEXT NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  query_count INTEGER NOT NULL,
  mean_efficiency_ratio REAL,
  mean_efficiency_ratio_local REAL,
  mean_efficiency_ratio_cloud REAL,
  mean_efficiency_ratio_hybrid REAL,
  mean_ttft_local_ms REAL,
  mean_ttft_cloud_ms REAL,
  answer_correct_rate REAL
);

CREATE INDEX benchmark_runs_run_at_idx ON benchmark_runs (run_at);
