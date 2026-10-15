-- A signed-in local engine. Only a hash of the token is stored, so a leaked
-- database cannot be replayed against the API; revoking one device leaves the
-- others signed in.
CREATE TABLE device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  -- Shown in the device list, e.g. "MacBook Air".
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX device_tokens_account_idx ON device_tokens (account_id) WHERE revoked_at IS NULL;
