-- A run asks once to use the cloud for its planning and hard steps (the
-- ModelPort order in docs/architecture/agent-workspace.md). That request
-- belongs to the run, not to a step, so it has no step_id; this index makes
-- "one per run" hold even when two calls race or a reclaimed run asks again.
CREATE UNIQUE INDEX agent_approvals_one_cloud_per_run
  ON agent_approvals (run_id)
  WHERE step_id IS NULL AND capability = 'cloud_model';
