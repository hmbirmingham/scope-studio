CREATE TABLE task_centroids (
  task TEXT PRIMARY KEY,
  embedding VECTOR(768) NOT NULL,
  example_count INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
