import { useEffect, useId, useMemo, useRef, useState } from 'react';
import AgentControls from './AgentControls.jsx';
import CapabilityGrid from './CapabilityGrid.jsx';
import { useWorkspace } from './workspaceContext.js';
import { useDialog } from './useDialog.js';
import { applyRole, blankForm, createRequest, fieldForError, formFromAgent, patchRequest, roleFields, validateForm } from './builderForm.js';
import { AGENT_COLORS, KNOWN_SOURCES, KNOWN_TAGS, LEVELS, MODEL_POLICIES } from './permissions.js';

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p className="ws-error" id={id} role="alert">
      {message}
    </p>
  );
}

// "All" or a chosen list, for one scope list. Items the agent already has but
// the map no longer lists stay visible so they can be removed.
function ScopePicker({ legend, allLabel, value, options, onChange }) {
  const choices = [...new Set([...options, ...value.items])];
  const toggle = (item, on) => onChange({ ...value, items: on ? [...value.items, item] : value.items.filter((entry) => entry !== item) });
  return (
    <fieldset className="ws-scope">
      <legend>{legend}</legend>
      <label className="ws-check">
        <input type="checkbox" checked={value.all} onChange={(event) => onChange({ ...value, all: event.target.checked })} />
        {allLabel}
      </label>
      {choices.length === 0 && !value.all && <p className="ws-hint">Nothing to choose from yet.</p>}
      {choices.map((item) => (
        <label key={item} className="ws-check">
          <input type="checkbox" disabled={value.all} checked={value.all || value.items.includes(item)} onChange={(event) => toggle(item, event.target.checked)} />
          {item}
        </label>
      ))}
    </fieldset>
  );
}

export default function AgentBuilder({ agent = null, onClose, onSaved }) {
  const { api, agents, plan, projects, sources, replaceAgent, removeAgent } = useWorkspace();
  const [form, setForm] = useState(() => (agent ? formFromAgent(agent) : blankForm(agents.length)));
  const [templates, setTemplates] = useState([]);
  const [roles, setRoles] = useState([]);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameInput = useRef(null);
  const drawer = useRef(null);
  const titleId = useId();
  const sliderId = useId();

  // The latest saved record, so the controls and the grid follow pause/kill.
  const saved = agent ? agents.find((entry) => entry.id === agent.id) ?? agent : null;

  // Before the effect that focuses the name, so it remembers the opener.
  useDialog(drawer, onClose);

  useEffect(() => {
    nameInput.current?.focus();
    api.listTemplates().then(setTemplates).catch(() => {});
    api.listRoles().then(setRoles).catch(() => {});
  }, [api]);


  const projectNames = useMemo(() => projects.map((entry) => (typeof entry === 'string' ? entry : entry.project)), [projects]);
  const sourceNames = useMemo(() => [...new Set([...KNOWN_SOURCES, ...sources])], [sources]);

  const update = (change) => {
    setForm((current) => ({ ...current, ...change(current) }));
    setDirty(true);
  };
  const setRole = (patch) => update((current) => ({ role: { ...current.role, ...patch } }));

  function sourceRoleFor(start) {
    if (start.startsWith('template:')) return templates.find((entry) => `template:${entry.template}` === start) ?? null;
    if (start.startsWith('role:')) return roles.find((entry) => `role:${entry.id}` === start) ?? null;
    return null;
  }

  function chooseStart(start) {
    const role = sourceRoleFor(start);
    if (role) {
      setForm((current) => applyRole(current, start, role));
    } else {
      setForm((current) => ({ ...current, start, role: { ...current.role, template: null } }));
    }
    setDirty(true);
  }

  async function save(event) {
    event.preventDefault();
    setNotice(null);
    const problems = validateForm(form, { ownKey: plan.ownKey });
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setSaving(true);
    try {
      let result;
      if (saved) {
        result = await api.updateAgent(saved.id, patchRequest(form));
      } else {
        const { body, rolePatch } = createRequest(form, sourceRoleFor(form.start));
        result = await api.createAgent(body);
        if (rolePatch) result = await api.updateAgent(result.id, { role: rolePatch });
      }
      replaceAgent(result);
      setDirty(false);
      onSaved?.(result);
    } catch (failure) {
      setErrors({ [fieldForError(failure.code)]: failure.message });
    } finally {
      setSaving(false);
    }
  }

  async function saveRole() {
    setNotice(null);
    if (!form.role.title.trim()) {
      setErrors({ role: 'The role needs a title.' });
      return;
    }
    try {
      const role = await api.createRole(roleFields(form.role));
      setRoles((current) => [...current, role]);
      setNotice(`Saved “${role.title}” to your roles.`);
    } catch (failure) {
      setErrors({ role: failure.message });
    }
  }

  async function remove() {
    try {
      await api.deleteAgent(saved.id);
      removeAgent(saved.id);
      onClose();
    } catch (failure) {
      setErrors({ form: failure.message });
    }
  }

  const levelIndex = Math.max(LEVELS.findIndex((level) => level.id === form.level), 0);
  const describe = (field) => (errors[field] ? `agent-error-${field}` : undefined);
  const errorList = Object.entries(errors).filter(([, message]) => message);

  return (
    <div className="ws-drawer-backdrop" onClick={onClose}>
      <section ref={drawer} className="ws-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="ws-drawer-head">
          <h2 id={titleId}>{saved ? `Edit ${saved.name}` : 'New agent'}</h2>
          <button type="button" className="ws-icon-btn" onClick={onClose} aria-label="Close the agent builder">
            ✕
          </button>
        </header>
        {saved && <AgentControls agent={saved} />}

        <form className="ws-form" onSubmit={save} noValidate>
          {errorList.length > 0 && (
            <div className="ws-error-summary" role="alert">
              <p>Check {errorList.length === 1 ? 'this' : 'these'} before saving:</p>
              <ul>
                {errorList.map(([field, message]) => (
                  <li key={field}>{message}</li>
                ))}
              </ul>
            </div>
          )}

          <section className="ws-section" aria-labelledby={`${titleId}-identity`}>
            <h3 id={`${titleId}-identity`}>Identity</h3>
            <label className="ws-field">
              Name
              <input
                ref={nameInput}
                value={form.name}
                maxLength={120}
                onChange={(event) => update(() => ({ name: event.target.value }))}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={describe('name')}
              />
            </label>
            <FieldError id="agent-error-name" message={errors.name} />
            <fieldset className="ws-colors">
              <legend>Cursor colour</legend>
              {AGENT_COLORS.map((color) => (
                <label key={color} className="ws-swatch" style={{ '--swatch': color }}>
                  <input type="radio" name="agent-color" value={color} checked={form.color.toLowerCase() === color} onChange={() => update(() => ({ color }))} />
                  <span className="ws-visually-hidden">{color}</span>
                </label>
              ))}
              <label className="ws-field is-inline">
                Custom
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(form.color) ? form.color : '#8a8a96'} onChange={(event) => update(() => ({ color: event.target.value }))} aria-describedby={describe('color')} />
              </label>
            </fieldset>
            <FieldError id="agent-error-color" message={errors.color} />
          </section>

          <section className="ws-section" aria-labelledby={`${titleId}-role`}>
            <h3 id={`${titleId}-role`}>Role</h3>
            {!saved && (
              <label className="ws-field">
                Start from
                <select value={form.start} onChange={(event) => chooseStart(event.target.value)}>
                  <option value="custom">Custom role</option>
                  {templates.length > 0 && (
                    <optgroup label="Built-in roles">
                      {templates.map((template) => (
                        <option key={template.template} value={`template:${template.template}`}>
                          {template.title}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {roles.length > 0 && (
                    <optgroup label="Your roles">
                      {roles.map((role) => (
                        <option key={role.id} value={`role:${role.id}`}>
                          {role.title}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
            )}
            <label className="ws-field">
              Title
              <input value={form.role.title} onChange={(event) => setRole({ title: event.target.value })} aria-invalid={Boolean(errors.role)} aria-describedby={describe('role')} />
            </label>
            <label className="ws-field">
              Description
              <textarea rows={2} value={form.role.description} onChange={(event) => setRole({ description: event.target.value })} />
            </label>
            <label className="ws-field">
              Persona the planner is given
              <textarea rows={3} value={form.role.embodiment} onChange={(event) => setRole({ embodiment: event.target.value })} />
            </label>
            <fieldset className="ws-tags">
              <legend>Capability tags</legend>
              {[...new Set([...KNOWN_TAGS, ...form.role.tags])].map((tag) => (
                <label key={tag} className="ws-check">
                  <input
                    type="checkbox"
                    checked={form.role.tags.includes(tag)}
                    onChange={(event) => setRole({ tags: event.target.checked ? [...form.role.tags, tag] : form.role.tags.filter((entry) => entry !== tag) })}
                  />
                  {tag}
                </label>
              ))}
            </fieldset>
            <FieldError id="agent-error-role" message={errors.role} />
            <button type="button" className="ws-btn is-quiet" onClick={saveRole}>
              Save this role for reuse
            </button>
            {notice && <p className="ws-hint" role="status">{notice}</p>}
          </section>

          <section className="ws-section" aria-labelledby={`${titleId}-permissions`}>
            <h3 id={`${titleId}-permissions`}>Permissions</h3>
            <label className="ws-field" htmlFor={sliderId}>
              Permission level: <strong>{LEVELS[levelIndex].label}</strong>
            </label>
            <input
              id={sliderId}
              className="ws-slider"
              type="range"
              min={0}
              max={LEVELS.length - 1}
              step={1}
              value={levelIndex}
              aria-valuetext={LEVELS[levelIndex].label}
              list={`${sliderId}-ticks`}
              onChange={(event) => update(() => ({ level: LEVELS[Number(event.target.value)].id }))}
            />
            <datalist id={`${sliderId}-ticks`}>
              {LEVELS.map((level, index) => (
                <option key={level.id} value={index} label={level.label} />
              ))}
            </datalist>
            <ol className="ws-slider-scale" aria-hidden="true">
              {LEVELS.map((level) => (
                <li key={level.id} className={level.id === form.level ? 'is-on' : ''}>
                  {level.label}
                </li>
              ))}
            </ol>
            <p className="ws-hint">{LEVELS[levelIndex].blurb}</p>
            <CapabilityGrid
              agent={saved}
              level={form.level}
              overrides={form.overrides}
              dirty={dirty}
              projects={projectNames}
              error={errors.overrides || errors.level}
              onOverride={(capability, choice) =>
                update((current) => {
                  const overrides = { ...current.overrides };
                  if (choice === 'inherit') delete overrides[capability];
                  else overrides[capability] = choice;
                  return { overrides };
                })
              }
            />
          </section>

          <section className="ws-section" aria-labelledby={`${titleId}-model`}>
            <h3 id={`${titleId}-model`}>Model</h3>
            <fieldset className="ws-radios" aria-describedby={describe('modelPolicy')}>
              <legend>Which models may it use?</legend>
              {MODEL_POLICIES.map((policy) => {
                const locked = policy.needsOwnKey && !plan.ownKey && form.modelPolicy !== policy.id;
                return (
                  <label key={policy.id} className={`ws-radio ${locked ? 'is-locked' : ''}`}>
                    <input type="radio" name="model-policy" value={policy.id} checked={form.modelPolicy === policy.id} disabled={locked} onChange={() => update(() => ({ modelPolicy: policy.id }))} />
                    <span>
                      <span className="ws-radio-label">{policy.label}</span>
                      <span className="ws-radio-blurb">{locked ? 'Needs the Key Pro plan.' : policy.blurb}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <FieldError id="agent-error-modelPolicy" message={errors.modelPolicy} />
          </section>

          <section className="ws-section" aria-labelledby={`${titleId}-budget`}>
            <h3 id={`${titleId}-budget`}>Budget per run</h3>
            <div className="ws-row">
              {[
                ['maxTokens', 'Tokens', '1000'],
                ['maxUsd', 'Dollars', '0.01'],
                ['wallMinutes', 'Minutes', '1'],
              ].map(([key, label, step]) => (
                <label key={key} className="ws-field">
                  {label}
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step={step}
                    value={form.budget[key]}
                    onChange={(event) => update((current) => ({ budget: { ...current.budget, [key]: event.target.value } }))}
                    aria-invalid={Boolean(errors.budget)}
                    aria-describedby={describe('budget')}
                  />
                </label>
              ))}
            </div>
            <FieldError id="agent-error-budget" message={errors.budget} />
          </section>

          <section className="ws-section" aria-labelledby={`${titleId}-scopes`}>
            <h3 id={`${titleId}-scopes`}>Scopes</h3>
            <ScopePicker legend="May read projects" allLabel="All projects" value={form.scopes.readProjects} options={projectNames} onChange={(value) => update((current) => ({ scopes: { ...current.scopes, readProjects: value } }))} />
            <ScopePicker legend="May read sources" allLabel="All sources" value={form.scopes.readSources} options={sourceNames} onChange={(value) => update((current) => ({ scopes: { ...current.scopes, readSources: value } }))} />
            <ScopePicker legend="May write to projects" allLabel="All projects" value={form.scopes.writeProjects} options={projectNames} onChange={(value) => update((current) => ({ scopes: { ...current.scopes, writeProjects: value } }))} />
            <FieldError id="agent-error-scopes" message={errors.scopes} />
          </section>

          <footer className="ws-drawer-foot">
            <FieldError id="agent-error-form" message={errors.form} />
            <button type="submit" className="ws-btn is-primary" disabled={saving}>
              {saving ? 'Saving…' : saved ? 'Save changes' : 'Create agent'}
            </button>
            <button type="button" className="ws-btn is-quiet" onClick={onClose}>
              Cancel
            </button>
            {saved &&
              (confirmDelete ? (
                <button type="button" className="ws-btn is-danger" onClick={remove}>
                  Delete {saved.name} for good
                </button>
              ) : (
                <button type="button" className="ws-btn is-quiet" onClick={() => setConfirmDelete(true)}>
                  Delete agent
                </button>
              ))}
          </footer>
        </form>
      </section>
    </div>
  );
}
