-- One row per person. The plan and the subscription behind it live here and
-- nowhere else: a local engine only caches the plan to show it.
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'key_pro', 'student', 'engineer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Each webhook re-reads the subscription from Stripe, so a late or repeated
  -- event cannot leave a stale plan.
  billing_customer_id TEXT UNIQUE,
  billing_subscription_id TEXT UNIQUE,
  billing_status TEXT,
  billing_price_id TEXT,
  billing_renews_at TIMESTAMPTZ,
  -- Set when a cancellation is scheduled: the plan runs until then.
  billing_cancel_at TIMESTAMPTZ,
  -- When the subscription was last read from Stripe.
  billing_updated_at TIMESTAMPTZ
);
