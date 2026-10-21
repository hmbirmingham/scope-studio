-- The link between a local user and their Scope Studio account on the control
-- plane (control/API.md). One row per local user who has signed in on this
-- machine. The device token is stored sealed (server/src/control/tokenBox.js),
-- never in plain text, and never leaves the engine except in the
-- Authorization header of a control-plane request.
--
-- `me` caches the last GET /v1/me answer: the plan, its limits and the next
-- platform model. The engine's plan rules read it instead of a billing table
-- of their own, and refresh it when it is older than the cache's TTL.
CREATE TABLE control_links (
  owner_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  token_sealed TEXT NOT NULL,
  -- The control plane's account id and email, for display; not secrets.
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  dev_mode BOOLEAN NOT NULL DEFAULT false,
  me JSONB,
  me_fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
