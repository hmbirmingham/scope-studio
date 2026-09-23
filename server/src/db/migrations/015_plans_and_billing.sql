-- Which plan a user is on, and who paid for a given answer. Spend on a user's
-- own key is not margin; spend on the platform's key is. A total that mixes
-- them cannot be separated afterwards.
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free', 'key_pro', 'student', 'engineer'));

ALTER TABLE query_metrics ADD COLUMN billed_to TEXT
  CHECK (billed_to IN ('user_key', 'platform'));
