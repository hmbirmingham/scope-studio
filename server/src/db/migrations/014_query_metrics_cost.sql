-- Metered tiers need what a query actually cost, per query: input and output
-- tokens are priced differently, so the ratio cannot be recovered later.
ALTER TABLE query_metrics ADD COLUMN cost_usd NUMERIC(12, 6);
