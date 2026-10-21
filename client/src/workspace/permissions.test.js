import { describe, expect, it } from 'vitest';
import { approvalSummary, capabilityLabel, defaultProjectFor } from './permissions.js';

describe('defaultProjectFor', () => {
  const agent = (projects) => ({ scopes: { write: { projects } } });

  it('offers the one listed project the agent may write to', () => {
    expect(defaultProjectFor(agent(['Lab']), ['Lab', 'Other'])).toBe('Lab');
    expect(defaultProjectFor(agent(['Lab', 'Gone']), ['Lab', 'Other'])).toBe('Lab');
  });

  it('leaves the choice to the user when it is not one project', () => {
    expect(defaultProjectFor(agent(['*']), ['Lab'])).toBe('');
    expect(defaultProjectFor(agent([]), ['Lab'])).toBe('');
    expect(defaultProjectFor(agent(['Lab', 'Other']), ['Lab', 'Other'])).toBe('');
    expect(defaultProjectFor(agent(['Gone']), ['Lab'])).toBe('');
    expect(defaultProjectFor(undefined, ['Lab'])).toBe('');
  });
});

describe('capability labels', () => {
  it('names plug-in capabilities and permissions by what they do', () => {
    expect(capabilityLabel('code.run_generated')).toBe('Run code in the sandbox');
    expect(capabilityLabel('graph.write_artifact')).toBe('Save to the map');
    expect(capabilityLabel('write_notes')).toBe('Write notes');
    expect(capabilityLabel('kicad.erc')).toBe('kicad.erc');
    expect(capabilityLabel(null)).toBe(null);
  });

  it('drops the capability prefix the runner puts on a step approval’s summary', () => {
    expect(approvalSummary({ capability: 'code.run_generated', summary: 'code.run_generated: Recompute g' })).toBe('Recompute g');
    expect(approvalSummary({ capability: 'cloud_model', summary: 'Use the cloud model' })).toBe('Use the cloud model');
    expect(approvalSummary({ capability: 'x' })).toBe('');
  });
});
