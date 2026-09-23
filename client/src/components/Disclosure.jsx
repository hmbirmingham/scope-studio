import { useState } from 'react';

// A line of work that happened, collapsed to one row. Open it to see what it
// did — the conversation stays readable and nothing is hidden.
export default function Disclosure({ summary, detail, tone, open: initial = false, children }) {
  const [open, setOpen] = useState(initial);

  return (
    <div className={`disclosure ${tone ? `is-${tone}` : ''} ${open ? 'is-open' : ''}`}>
      <button type="button" className="disclosure-row" onClick={() => setOpen(!open)}>
        <span className="disclosure-summary">{summary}</span>
        {detail && <span className="disclosure-detail">{detail}</span>}
        <span className="disclosure-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  );
}
