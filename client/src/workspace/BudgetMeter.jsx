import { useEffect, useState } from 'react';
import { budgetUsage } from './runState.js';

const formatTokens = (value) => (value >= 10_000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)));
const formatUsd = (value) => `$${value.toFixed(value < 1 ? 3 : 2)}`;
const formatWall = (ms) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

function Meter({ label, used, limit, fraction, format, exceeded }) {
  const percent = Math.round(fraction * 100);
  return (
    <div className={`ws-meter ${exceeded ? 'is-exceeded' : fraction >= 0.8 ? 'is-high' : ''}`}>
      <span className="ws-meter-label">{label}</span>
      <progress max={100} value={percent} aria-label={`${label} used`} aria-valuetext={`${format(used)}${limit ? ` of ${format(limit)}` : ''}`} />
      <span className="ws-meter-value">
        {format(used)}
        {limit ? ` / ${format(limit)}` : ''}
      </span>
    </div>
  );
}

// Tokens, dollars and wall clock against the run's budget. The clock ticks
// once a second while the run is live; nothing else re-renders it.
export default function BudgetMeter({ run, exceeded, live }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const usage = budgetUsage(run, now);
  return (
    <div className="ws-meters" aria-label="Budget">
      <Meter label="Tokens" {...usage.tokens} format={formatTokens} exceeded={exceeded === 'maxTokens'} />
      <Meter label="Cost" {...usage.usd} format={formatUsd} exceeded={exceeded === 'maxUsd'} />
      <Meter label="Time" {...usage.wall} format={formatWall} exceeded={exceeded === 'maxWallMs'} />
    </div>
  );
}
