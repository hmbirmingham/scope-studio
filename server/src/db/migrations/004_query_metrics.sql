CREATE TABLE query_metrics (
  query_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  embedding_latency_ms INTEGER,
  retrieval_latency_ms INTEGER,
  nodes_retrieved INTEGER,
  tokens_injected INTEGER,
  tokens_available INTEGER,
  efficiency_ratio REAL,

  routing_decision TEXT CHECK (routing_decision IN ('local', 'cloud', 'hybrid')),
  routing_decision_ms INTEGER,
  routing_reason TEXT CHECK (routing_reason IN ('privacy_flag', 'context_size', 'complexity', 'no_ollama')),

  model_used TEXT,
  ttft_ms INTEGER,
  total_response_ms INTEGER,
  output_tokens INTEGER,

  answer_correct BOOLEAN,
  ground_truth_id TEXT
);

CREATE INDEX query_metrics_routing_decision_idx ON query_metrics (routing_decision);
