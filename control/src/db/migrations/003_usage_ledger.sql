-- Every platform-paid cloud answer, and the record the weekly allowance and
-- monthly answer limit are enforced against. It holds what an answer cost,
-- never what was asked or answered.
CREATE TABLE usage_ledger (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Sent by the engine; a retried request records its cost once.
  request_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  hard BOOLEAN NOT NULL DEFAULT false,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_account_time_idx ON usage_ledger (account_id, created_at);
