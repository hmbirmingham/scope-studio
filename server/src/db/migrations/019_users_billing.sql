-- The subscription behind a user's plan. users.plan stays the one thing the
-- rest of the server reads; these columns record why it has that value, so a
-- webhook arriving late or twice can be checked against what is already known.
ALTER TABLE users
  ADD COLUMN billing_subscription_id TEXT UNIQUE,
  ADD COLUMN billing_customer_id TEXT,
  ADD COLUMN billing_status TEXT,
  ADD COLUMN billing_variant_id TEXT,
  ADD COLUMN billing_renews_at TIMESTAMPTZ,
  ADD COLUMN billing_ends_at TIMESTAMPTZ,
  -- The provider's own updated_at for the last event applied: older events
  -- are ignored, so a late webhook cannot undo a newer change.
  ADD COLUMN billing_updated_at TIMESTAMPTZ;
