-- The per-run cost ledger (docs/architecture/agent-workspace.md, path B). One
-- row per model call, so a run's totals are a sum anyone can re-check and a
-- budget can never drift from what was actually spent. It records counts and
-- money only: prompt and answer text never land here.
CREATE TABLE agent_run_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  -- A step that was redone after a crash keeps its row id, so the ledger still
  -- shows what the abandoned attempt spent.
  step_id UUID REFERENCES agent_run_steps (id) ON DELETE SET NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('plan', 'step', 'capability')),
  adapter TEXT NOT NULL CHECK (adapter IN ('local', 'own_key', 'platform')),
  -- The adapter that was chosen but refused (platform_unavailable), when the
  -- call fell back to local.
  fallback_from TEXT CHECK (fallback_from IN ('own_key', 'platform')),
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_run_costs_run_idx ON agent_run_costs (run_id);
CREATE INDEX agent_run_costs_step_idx ON agent_run_costs (step_id);
