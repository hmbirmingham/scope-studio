-- Whether the person got an answer. A row is written for every answer the
-- platform paid for, so spend is never under-counted, but an answer that failed
-- upstream partway through did not reach the person and must not use up one of
-- their monthly answers. A client that hung up still had its answer, so its row
-- stays completed. Existing rows predate the distinction and keep counting.
ALTER TABLE usage_ledger ADD COLUMN completed BOOLEAN NOT NULL DEFAULT true;
