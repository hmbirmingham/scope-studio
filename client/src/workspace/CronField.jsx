import { useId, useMemo } from 'react';
import { CRON_PRESETS, cronError, describeCron, nextRuns } from './cron.js';

const formatUtc = (date) =>
  `${date.toLocaleString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;

// A schedule picker: a few presets, or five cron fields typed by hand, with a
// sentence and the next runs underneath so the user can see what they chose.
export default function CronField({ value, onChange, error, now }) {
  const id = useId();
  const preset = CRON_PRESETS.find((entry) => entry.expression === value)?.id ?? 'custom';
  const preview = useMemo(() => {
    const problem = cronError(value);
    if (problem) return { problem };
    return { sentence: describeCron(value), upcoming: nextRuns(value, now ?? new Date(), 3) };
  }, [value, now]);
  const problem = error ?? preview.problem ?? null;

  return (
    <fieldset className="ws-cron">
      <legend>Schedule (UTC)</legend>
      <label className="ws-field">
        Repeat
        <select
          value={preset}
          onChange={(event) => {
            const chosen = CRON_PRESETS.find((entry) => entry.id === event.target.value);
            if (chosen) onChange(chosen.expression);
          }}
        >
          {CRON_PRESETS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>
      <label className="ws-field">
        Cron expression
        <input
          value={value}
          spellCheck={false}
          autoComplete="off"
          className="ws-mono"
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(problem)}
          aria-describedby={`${id}-preview`}
        />
      </label>
      <div id={`${id}-preview`} className="ws-cron-preview" aria-live="polite">
        {problem ? (
          <p className="ws-error">{problem}</p>
        ) : (
          <>
            <p className="ws-cron-sentence">{preview.sentence}</p>
            {preview.upcoming.length > 0 && (
              <p className="ws-hint">Next: {preview.upcoming.map(formatUtc).join(' · ')}</p>
            )}
          </>
        )}
      </div>
    </fieldset>
  );
}
