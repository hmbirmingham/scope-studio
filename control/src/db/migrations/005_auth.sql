-- Browser sessions for the sign-in and billing pages, in the shape
-- connect-pg-simple expects. Named for the control plane so it can never be
-- confused with the local engine's own session table.
CREATE TABLE control_session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX control_session_expire_idx ON control_session (expire);

-- One-time codes handed to a local engine through its loopback redirect.
-- Only a hash is stored, like device tokens, and the code is useless without
-- the verifier the engine kept to itself (PKCE), so a code read off the
-- redirect or out of this table cannot be exchanged by anyone else.
CREATE TABLE auth_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- base64url(SHA-256(code_verifier)); S256 is the only method accepted.
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  -- The device label the engine asked for, copied onto the device token.
  label TEXT,
  dev_mode BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set on the first exchange, successful or not, so a code works once.
  used_at TIMESTAMPTZ
);
CREATE INDEX auth_codes_expires_idx ON auth_codes (expires_at);

-- Dev mode belongs to a device, not to the account: a developer can test the
-- Engineer plan on one machine without the account's billed plan changing,
-- and accounts.plan stays the column only billing writes.
ALTER TABLE device_tokens ADD COLUMN dev_mode BOOLEAN NOT NULL DEFAULT false;

-- Every dev-mode sign-in, kept even if the account or device goes away, since
-- an unbilled Engineer plan is exactly what an audit needs to be able to see.
CREATE TABLE dev_logins (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID REFERENCES accounts (id) ON DELETE SET NULL,
  device_token_id UUID REFERENCES device_tokens (id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  label TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dev_logins_account_idx ON dev_logins (account_id, created_at);
