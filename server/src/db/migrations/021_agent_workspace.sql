-- The shared agent-workspace tables (docs/architecture/agent-workspace.md).
-- Every table hangs off the owning user with ON DELETE CASCADE, so deleting a
-- user removes their agents and runs and nothing is left orphaned.

-- A user's own reusable roles. The built-in templates live in code
-- (src/workspace/roles.js) so they can improve without a migration.
CREATE TABLE agent_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  embodiment TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_roles_owner_idx ON agent_roles (owner_id);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- A copy of the role the agent started from; every field stays editable.
  role JSONB NOT NULL DEFAULT '{}',
  level TEXT NOT NULL DEFAULT 'supervised'
    CHECK (level IN ('manual', 'supervised', 'sandboxed', 'agentic')),
  overrides JSONB NOT NULL DEFAULT '{}',
  scopes JSONB NOT NULL DEFAULT '{"read":{"projects":[],"sources":[]},"write":{"projects":[]}}',
  model_policy TEXT NOT NULL DEFAULT 'local_only'
    CHECK (model_policy IN ('local_only', 'local_cloud', 'own_key')),
  budget JSONB NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'killed')),
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agents_owner_idx ON agents (owner_id);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  project TEXT,
  -- Five-field cron in UTC; NULL for a one-off task.
  schedule TEXT,
  next_run_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_owner_idx ON tasks (owner_id);
CREATE INDEX tasks_due_idx ON tasks (next_run_at) WHERE enabled AND schedule IS NOT NULL;

-- The durable queue. A worker claims the oldest queued run with
-- FOR UPDATE SKIP LOCKED and holds a lease; an expired lease means the worker
-- died and the run is reclaimed from its last checkpoint.
CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks (id) ON DELETE SET NULL,
  instructions TEXT NOT NULL,
  project TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'paused', 'waiting_approval',
    'succeeded', 'failed', 'killed', 'budget_exceeded'
  )),
  plan_node_id UUID REFERENCES nodes (id) ON DELETE SET NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  checkpoint JSONB NOT NULL DEFAULT '{}',
  budget JSONB NOT NULL DEFAULT '{}',
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  wall_ms BIGINT NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX agent_runs_owner_idx ON agent_runs (owner_id, queued_at DESC);
CREATE INDEX agent_runs_queue_idx ON agent_runs (queued_at) WHERE status = 'queued';
CREATE INDEX agent_runs_lease_idx ON agent_runs (lease_until) WHERE status = 'running';

CREATE TABLE agent_run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  index INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'act')),
  capability TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'waiting_approval', 'verified', 'failed', 'rejected', 'done'
  )),
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  verification JSONB,
  adapter TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  node_ids UUID[] NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (run_id, index)
);

CREATE TABLE agent_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  run_id UUID REFERENCES agent_runs (id) ON DELETE CASCADE,
  step_id UUID REFERENCES agent_run_steps (id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX agent_approvals_pending_idx ON agent_approvals (owner_id, created_at) WHERE status = 'pending';
