import { useCallback, useEffect, useState } from 'react';

// What each plan sells, in the words a buyer reads. Limits mirror
// server/src/billing/plans.js; the server enforces them, this only describes.
const PLAN_CARDS = [
  { plan: 'free', name: 'Free', blurb: 'Unlimited local answers. Nothing leaves your machine.' },
  { plan: 'key_pro', name: 'Key Pro', blurb: 'Unlimited local, plus cloud on your own Anthropic key — choose Sonnet, Opus or Haiku, and web search.' },
  { plan: 'student', name: 'Student', blurb: 'Unlimited local, plus 200 cloud answers a month for the questions local gets wrong.' },
  { plan: 'engineer', name: 'Engineer', blurb: 'Unlimited local, plus 340 cloud answers a month, with Opus for the hard ones.' },
];

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);

export default function PlanOverlay({ open, onClose, onPlanChanged }) {
  const [billing, setBilling] = useState(null);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/billing');
    if (response.ok) setBilling(await response.json());
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Back from checkout: the webhook may land a moment after the redirect, so
  // the plan is re-read a few times rather than trusted from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing') !== 'done') return undefined;
    window.history.replaceState(null, '', window.location.pathname);
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      const response = await fetch('/api/billing');
      if (response.ok) {
        const body = await response.json();
        setBilling(body);
        if (body.plan !== 'free' || tries >= 10) {
          clearInterval(timer);
          onPlanChanged?.();
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [onPlanChanged]);

  if (!open) return null;

  async function go(path, body, label) {
    setBusy(label);
    setProblem(null);
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(null);
    if (!response.ok || !payload.url) return setProblem(payload.error ?? 'Could not reach billing.');
    // Checkout replaces the page and returns here; the portal opens beside it.
    if (path.endsWith('/portal')) window.open(payload.url, '_blank', 'noopener');
    else window.location.assign(payload.url);
  }

  const current = billing?.plan ?? 'free';
  const renews = formatDate(billing?.renewsAt);
  const cancels = formatDate(billing?.cancelAt);

  return (
    <div className="inspector-backdrop" onClick={onClose}>
      <section className="inspector plans" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="inspector-head">
          <div className="inspector-type">settings</div>
          <div className="inspector-title">Plan</div>
          <div className="inspector-sub">
            {cancels && current !== 'free'
              ? `Cancelled — ${PLAN_CARDS.find((c) => c.plan === current)?.name} until ${cancels}.`
              : renews && current !== 'free'
                ? `Renews ${renews}.`
                : 'Payments and tax are handled by Stripe.'}
          </div>
        </div>

        {billing && !billing.configured && (
          <div className="row-note is-warn">Billing isn't set up on this server yet.</div>
        )}
        {problem && <div className="row-note is-warn">{problem}</div>}

        <div className="plan-cards">
          {PLAN_CARDS.map((card) => {
            const isCurrent = card.plan === current;
            const price = billing?.prices?.[card.plan];
            return (
              <div key={card.plan} className={`plan-card ${isCurrent ? 'is-current' : ''}`}>
                <div className="plan-card-head">
                  <span className="plan-name">{card.name}</span>
                  <span className="plan-price">{price ? `$${price}/mo` : 'Free'}</span>
                </div>
                <p className="plan-blurb">{card.blurb}</p>
                {isCurrent ? (
                  <span className="plan-current">Your plan</span>
                ) : card.plan !== 'free' && !billing?.hasSubscription ? (
                  <button
                    type="button"
                    className="row-approve"
                    disabled={!billing?.configured || Boolean(busy)}
                    onClick={() => go('/api/billing/checkout', { plan: card.plan }, card.plan)}
                  >
                    {busy === card.plan ? 'Opening checkout…' : `Choose ${card.name}`}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        {billing?.hasSubscription && (
          <button type="button" className="sources-action" disabled={Boolean(busy)} onClick={() => go('/api/billing/portal', null, 'portal')}>
            {busy === 'portal' ? 'Opening…' : 'Manage billing — change plan, card, or cancel'}
          </button>
        )}
      </section>
    </div>
  );
}
