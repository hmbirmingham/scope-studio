import { useCallback, useEffect, useRef, useState } from 'react';
import { webUrl } from '../lib/webUrl.js';

// What each plan sells, in the words a buyer reads. Limits mirror
// control/src/billing/plans.js; the control plane enforces them, this only describes.
const PLAN_CARDS = [
  { plan: 'free', name: 'Free', blurb: 'Unlimited local answers. Nothing leaves your machine.' },
  { plan: 'key_pro', name: 'Key Pro', blurb: 'Unlimited local, plus cloud on your own Anthropic key — choose Sonnet, Opus or Haiku, and web search.' },
  { plan: 'student', name: 'Student', blurb: 'Unlimited local, plus 200 cloud answers a month for the questions local gets wrong.' },
  { plan: 'engineer', name: 'Engineer', blurb: 'Unlimited local, plus 340 cloud answers a month, with Opus for the hard ones.' },
];

// How often, and for how long, the overlay re-reads the account while the
// person finishes something in another tab (signing in, or paying).
const POLL_MS = 2000;
const POLL_TRIES = 90;

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);

async function readJson(path, init) {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, body };
}

const post = (path, body) =>
  readJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// Plans and billing live on the Scope Studio account (the control plane). The
// engine signs in to it through the browser and forwards billing to it, so
// this overlay shows the account first: signed out, it still lists the plans
// and offers sign-in; signed in, it offers checkout or the billing portal.
export default function PlanOverlay({ open, onClose, onPlanChanged }) {
  const [billing, setBilling] = useState(null);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const [waiting, setWaiting] = useState(null);
  const timer = useRef(null);

  const stopWaiting = useCallback(() => {
    clearInterval(timer.current);
    timer.current = null;
    setWaiting(null);
  }, []);

  const load = useCallback(async () => {
    const { ok, body } = await readJson('/api/billing');
    if (ok) setBilling(body);
    return ok ? body : null;
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    readJson('/api/billing').then(({ ok, body }) => {
      if (!cancelled && ok) setBilling(body);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => () => clearInterval(timer.current), []);

  // Re-reads the account until `done(body)` says the other tab has finished.
  const waitFor = useCallback(
    (label, done) => {
      clearInterval(timer.current);
      setWaiting(label);
      let tries = 0;
      timer.current = setInterval(async () => {
        tries += 1;
        const body = await load();
        if ((body && done(body)) || tries >= POLL_TRIES) {
          stopWaiting();
          onPlanChanged?.();
        }
      }, POLL_MS);
    },
    [load, onPlanChanged, stopWaiting]
  );

  if (!open) return null;

  // Closing the overlay stops any waiting.
  function close() {
    stopWaiting();
    onClose();
  }

  async function signIn() {
    setBusy('signin');
    setProblem(null);
    const { ok, body } = await post('/api/control/signin');
    setBusy(null);
    if (!ok || !body.url) return setProblem(body.error ?? 'Could not start signing in.');
    const url = webUrl(body.url);
    if (!url) return setProblem('The sign-in link was not a web address, so it was not opened.');
    window.open(url, '_blank', 'noopener');
    waitFor('signin', (next) => next.signedIn);
  }

  async function signOut() {
    setBusy('signout');
    setProblem(null);
    await post('/api/control/signout');
    setBusy(null);
    await load();
    onPlanChanged?.();
  }

  // Checkout and the portal are Stripe pages the control plane opens; they
  // finish on its own "return to the app" page, so they open beside this one
  // and the overlay watches for the plan to change.
  async function go(path, body, label) {
    setBusy(label);
    setProblem(null);
    const before = billing?.plan;
    const { ok, body: payload } = await post(path, body);
    setBusy(null);
    if (!ok || !payload.url) return setProblem(payload.error ?? 'Could not reach billing.');
    const url = webUrl(payload.url);
    if (!url) return setProblem('The billing link was not a web address, so it was not opened.');
    window.open(url, '_blank', 'noopener');
    waitFor(label, (next) => next.plan !== before || (label === 'portal' && next.cancelAt !== billing?.cancelAt));
  }

  const signedIn = billing?.signedIn === true;
  const current = billing?.plan ?? 'free';
  const renews = formatDate(billing?.renewsAt);
  const cancels = formatDate(billing?.cancelAt);
  const canBuy = signedIn && billing?.configured && !busy;

  return (
    <div className="inspector-backdrop" onClick={close}>
      <section className="inspector plans" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="inspector-close" onClick={close} aria-label="Close">
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

        {billing && !billing.accountsConfigured && (
          <div className="row-note is-warn">Accounts aren't set up on this engine (CONTROL_URL). Local answers work as normal.</div>
        )}
        {billing?.accountsConfigured && !signedIn && (
          <div className="row-note">
            Sign in to your Scope Studio account to choose a plan. Until then this engine answers locally.{' '}
            <button type="button" className="row-approve" disabled={Boolean(busy) || waiting === 'signin'} onClick={signIn}>
              {waiting === 'signin' ? 'Waiting for the browser…' : busy === 'signin' ? 'Opening…' : 'Sign in'}
            </button>
          </div>
        )}
        {signedIn && (
          <div className="row-note">
            Signed in as {billing.email}.{' '}
            {!billing.online && 'The account service is unreachable, so this engine answers locally for now. '}
            <button type="button" className="sources-action" disabled={Boolean(busy)} onClick={signOut}>
              {busy === 'signout' ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        )}
        {signedIn && billing.online && !billing.configured && (
          <div className="row-note is-warn">
            {billing.billingError
              ? `Billing could not be loaded: ${billing.billingError.error}`
              : "Billing isn't set up on the account service yet."}
          </div>
        )}
        {waiting && waiting !== 'signin' && <div className="row-note">Finish in the tab that opened; this updates when it's done.</div>}
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
                    disabled={!canBuy}
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
