-- A per-query tier choice by the user is its own routing reason: logging it as
-- context_size or complexity would corrupt the routing-distribution metrics.
ALTER TABLE query_metrics DROP CONSTRAINT query_metrics_routing_reason_check;
ALTER TABLE query_metrics ADD CONSTRAINT query_metrics_routing_reason_check
  CHECK (routing_reason IN ('privacy_flag', 'context_size', 'complexity', 'no_ollama', 'user_override'));
