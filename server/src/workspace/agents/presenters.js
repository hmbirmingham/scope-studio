// camelCase JSON shapes from "HTTP shapes" in docs/architecture/agent-workspace.md.

const iso = (value) => (value ? new Date(value).toISOString() : null);

export function presentRole(row) {
  return {
    id: row.id,
    template: null,
    title: row.title,
    description: row.description,
    embodiment: row.embodiment,
    tags: row.tags,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function presentAgent(row) {
  const role = row.role ?? {};
  return {
    id: row.id,
    name: row.name,
    role: {
      template: role.template ?? null,
      title: role.title ?? '',
      description: role.description ?? '',
      embodiment: role.embodiment ?? '',
      tags: role.tags ?? [],
    },
    level: row.level,
    overrides: row.overrides ?? {},
    scopes: row.scopes,
    modelPolicy: row.model_policy,
    budget: row.budget,
    state: row.state,
    color: row.color,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function presentTask(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    instructions: row.instructions,
    project: row.project,
    schedule: row.schedule,
    nextRunAt: iso(row.next_run_at),
    enabled: row.enabled,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function presentApproval(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id,
    stepId: row.step_id,
    capability: row.capability,
    summary: row.summary,
    detail: row.detail,
    status: row.status,
    createdAt: iso(row.created_at),
    resolvedAt: iso(row.resolved_at),
  };
}
