-- What the runner needs to resume a step it parked or lost: the chooser's
-- decision, the nodes the step read, and why a step failed. `input` stays the
-- capability input the user sees; this is the runner's own bookkeeping.
ALTER TABLE agent_run_steps
  ADD COLUMN detail JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN error TEXT;
