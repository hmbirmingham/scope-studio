-- The subscription behind a user's plan. users.plan stays the one thing the
-- rest of the server reads; these columns record why it has that value. Each
-- webhook reads the subscription's current state from Stripe, so a late or
-- repeated event cannot leave a stale plan.
ALTER TABLE users
  ADD COLUMN billing_customer_id TEXT UNIQUE,
  ADD COLUMN billing_subscription_id TEXT UNIQUE,
  ADD COLUMN billing_status TEXT,
  ADD COLUMN billing_price_id TEXT,
  ADD COLUMN billing_renews_at TIMESTAMPTZ,
  -- Set when a cancellation is scheduled: the plan runs until then.
  ADD COLUMN billing_cancel_at TIMESTAMPTZ,
  -- When the subscription was last read from Stripe.
  ADD COLUMN billing_updated_at TIMESTAMPTZ;
