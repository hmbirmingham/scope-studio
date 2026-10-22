# Launch pricing: Free with your own key, and one $20 subscription

**Status: design note. Nothing here is implemented.** It describes one
reviewable pull request and the order to roll it out in. Until that pull
request merges, the plans in code are the four in
[ARCHITECTURE.md §5](../../ARCHITECTURE.md#5-model-tier-configuration)
(Free, Key Pro, Student, Engineer), and that is what the product does.

## The decision

Hynes decided three things, and only these:

1. **No tiers before an MVP.**
2. **Free** is the full local experience **plus bring-your-own Anthropic
   key**.
3. **One $20/month subscription** is the upgrade, **replacing Key Pro ($5),
   Student ($12) and Engineer ($25)**. The replaced plans are no longer sold.

## Proposals (not decided)

Everything else in this note is a **proposal** for Hynes to confirm or
change. The main ones, each used throughout the rest of the note:

- **The name "Pro"** for the $20 subscription, and `pro` as its plan key.
  Every mention of Pro below means "the $20 subscription, under its proposed
  name".
- **What the subscription buys: platform-paid cloud answers through the
  control plane, metered** (a monthly answer count and a weekly dollar
  allowance) the way Student and Engineer are today. The figures (270
  answers, Sonnet with Opus for hard questions) are in section 1.
- **What the own key does on Free:** Cloud and web search when the user
  chooses them, and also the hard questions on Auto, as Key Pro does today.
  The narrower alternative is to use the key only when the user picks Cloud
  or web search.
- What happens to existing subscribers (section 3), and the open questions at
  the end.

## What changes, in one pull request

### 1. The tier table (`server/src/billing/plans.js` and `control/src/billing/plans.js`)

The two files are mirrors and change together; the control plane's copy is
the authority for platform-paid answers (`control/API.md`, "Platform cloud").

Proposed `PLANS`:

```js
// SONNET and OPUS stand for the two model ids already listed in CLOUD_MODELS.
// Shared by Free and every legacy plan that lives on the user's own key.
const OWN_KEY = {
  chooseCloud: true, autoCloud: true, ownKey: true, platformPaid: false,
  models: { default: SONNET, hard: SONNET }, choosable: CLOUD_MODELS, effort: 'medium',
};

export const PLANS = {
  // Everything local, unlimited. With the user's own Anthropic key, Cloud,
  // web search and Auto's hard questions run on that key.
  free: { priceUsd: 0, ...OWN_KEY },
  // The one paid plan: platform-paid cloud on Auto, and the user's own key
  // for anything they choose themselves.
  pro: {
    priceUsd: 20, chooseCloud: true, autoCloud: true, ownKey: true, platformPaid: true, monthlyAnswers: 270,
    models: { default: SONNET, hard: OPUS }, choosable: CLOUD_MODELS, effort: 'medium',
  },

  // Legacy plans: kept only so existing subscriptions keep working until they
  // end (see "Existing subscribers"). Never sold, never offered in the UI.
  key_pro: { priceUsd: 5, legacy: true, ...OWN_KEY },
  student: { /* unchanged from today */ legacy: true },
  engineer: { /* unchanged from today */ legacy: true },
};

export const SELLABLE_PLANS = Object.freeze(['pro']);
```

Pro's figures, derived the way the current plans are (`netRevenueUsd`,
`monthlyCloudBudgetUsd`, `measuredAnswerUsd`; Stripe Managed Payments fees
6.4% + $0.30, 60% target margin):

| | Pro (proposed) |
|---|---|
| Net of fees | $18.42 |
| Platform cloud budget / month | $7.37 ($1.72 / week) |
| Models | Sonnet; Opus for hard questions (Engineer's mix, $0.027 / answer measured) |
| Monthly answers | **270** (at most 272 fit; 270 × $0.027 = $7.29, a 60.4% margin) |

The alternative is Sonnet throughout (Student's mix, $0.020 / answer), which
fits 360 answers at a 60.9% margin. Opus for hard questions is proposed
because it is what Engineer subscribers have today and the hard questions are
where it was measured to earn its cost.

Three helpers change with the table:

- `monthlyCloudBudgetUsd` checks `platformPaid` **before** `ownKey`. Today an
  `ownKey` plan returns `null` first, which would give Pro (which has both) no
  budget at all.
- `canChooseCloud` stays `plan.chooseCloud === true`, which now includes Free.
- `resolveCloudModel`'s fallback reads `PLANS.free.models.default` instead of
  `PLANS.key_pro`.

### 2. Own key on Free (engine)

Today an own-key request is decided by the plan name `key_pro` in several
places. Each one moves to the plan's `ownKey` / `platformPaid` flags, so a
legacy Key Pro account and a Free account behave the same:

| File | Change |
|---|---|
| `server/src/billing/credential.js` | Split by request instead of by plan: an **explicit** Cloud or web request uses the user's key on any plan with `ownKey` (blocked code `cloud_requires_own_key` otherwise, which no current plan triggers). An **Auto** request on a `platformPaid` plan goes through the control plane while the allowance lasts, exactly as Student and Engineer do today; on any other `ownKey` plan it uses the user's key if one was sent, and otherwise has no cloud. Past Pro's allowance, Auto stays local; it does not move to the user's key (see open questions). |
| `server/src/routes/chat.js` | `keyProOnly()` and the `cloud_requires_key_pro` refusal become `ownKeyOnly()` / `cloud_requires_own_key`; the sentence says "add your own Anthropic key in Sources" rather than naming a plan. |
| `server/src/workspace/modelPort.js` | `selectAdapter`: `own_key` policy allowed when `planFor(plan).ownKey`; `local_cloud` uses `platform` when `platformPaid`, else `own_key` when the plan has `ownKey` and a key is present, else local. Reasons `own_key_requires_key_pro` → `own_key_not_in_plan`. |
| `server/src/workspace/agents/validation.js` | `validateModelPolicy`: `own_key` allowed when `planFor(plan).ownKey` (code `own_key_not_in_plan`). `agentInput.js` keeps passing the control plane's plan; it simply no longer refuses Free. |
| `server/src/routes/billing.js` | `PAID_PLANS` becomes `SELLABLE_PLANS` imported from `plans.js`; the 400 says `plan must be pro`. |
| `server/src/benchmark/endurance/platformRules.js` | Mirrors `credential.js` (same split). |
| `server/src/benchmark/endurance/arms.js` | Line 196, `const meters = !canChooseCloud(plan) && canAutoCloud(plan);`, decides whether the arm meters platform answers. Pro has `chooseCloud: true`, so it would never be metered. Same fix as `monthlyCloudBudgetUsd`: `const meters = planFor(plan).platformPaid === true;`. |
| `server/src/benchmark/endurance/scenarios.js`, `server/benchmarks/sessions/**/*.json` | `SCENARIO_PLANS = ['pro']`; the five session files that name `engineer` or `student` name `pro`. |
| `server/src/benchmark/tasks/models.js`, `scopeArm.js` | `SCOPE_CLOUD_PLAN = 'pro'`. Same models as Engineer, so the dry benchmark's figures do not change. |

`server/src/control/plan.js` needs no change: `knownPlan` accepts any key of
`PLANS`, so `pro` becomes known when the table has it. The engine's old
`users.plan` column (migration 015) is no longer read or written by anything
and needs no change either.

A known limit that this pull request does not lift: background agent runs
have no `own_key` adapter (`server/src/workspace/runner/worker.js`), because
the key travels per request and is never stored. An agent with
`modelPolicy: 'own_key'` therefore plans locally (`no_key`) on every plan,
Free included. Storing a key for background runs is a separate decision.

### 3. Existing subscribers (the migration mapping)

First, count them on the control plane database (read-only):

```sql
SELECT plan, billing_status, count(*) FROM accounts WHERE plan <> 'free' GROUP BY 1, 2;
```

If the answer is no paying subscribers (likely before an MVP), the legacy
entries can be dropped from `PLANS` in a later clean-up once nothing refers to
them; the mapping below still applies to dev-mode devices.

| Old plan | New plan | How | Proposed |
|---|---|---|---|
| `free` | `free` | Nothing to do. | Gains own key. |
| `key_pro` ($5) | `free` | Hynes sets each Key Pro subscription to cancel at period end in the Stripe Dashboard. The webhook records `billing_cancel_at`; when the period ends Stripe deletes the subscription and the webhook sets `free`. Until then `key_pro` behaves exactly like Free (same `OWN_KEY` rules), so nothing changes for the person. | Whether to refund the unused part is Hynes's call in the Dashboard; no code involved. |
| `student` ($12, 200 answers) | `pro` ($20, 270 answers), **only with consent** | Grandfathered: `student` stays a working legacy plan at its price. The customer portal is configured to offer a switch to Pro only. They are told by email. | Never raise a price without the person choosing it. |
| `engineer` ($25, 340 answers) | `pro` ($20, 270 answers), **only with consent** | Grandfathered the same way. Pro is cheaper but has fewer answers, so moving them silently would cut what they paid for. | Same email and portal switch. |
| dev-mode devices | `pro` | `DEV_MODE_PLAN = 'pro'` in `control/src/auth/devMode.js`. `accounts.plan` is never written for dev mode, so nothing to migrate. | |

Stripe operations (cancelling Key Pro, portal configuration, emails) are done
by Hynes in the Stripe Dashboard. The pull request adds no script that calls
Stripe with a real key.

### 4. The new Stripe price (`STRIPE_PRICE_PRO`)

Hynes creates the Pro product and its $20 monthly price in Stripe (test mode
first, then live), and sets its id as `STRIPE_PRICE_PRO` on the control
plane's Railway service. No value is ever written into code, config, tests or
docs; tests use obviously fake ids (`price_pro`) against `control/test/fakeStripe.js`.
A price id carries no mode prefix, so a test price in a live account cannot be
caught by the prefix check `billingConfig` does for keys: Checkout fails with
Stripe's own error, logged by name (the existing `stripe_error` path).

### 5. Control plane: additive and backward compatible

`control/` auto-deploys to Railway from `dev` (Watch Paths `/control/**`) and
must still start and still bill with **today's variables** (no
`STRIPE_PRICE_PRO`). Start-up only needs `DATABASE_URL` and
`CONTROL_SESSION_SECRET` (`control/src/config/env.js`), and that does not
change. Billing is configured per request by `billingConfig()`
(`control/src/billing/stripe.js`), and that is where the trap is: today every
`PLAN_PRICE_ENV` variable is in `REQUIRED`, so simply adding `pro:
'STRIPE_PRICE_PRO'` to the table would turn billing **off** on Railway (one
logged "missing STRIPE_PRICE_PRO") the moment it deployed, for every existing
subscriber's webhooks too.

The changes, each additive:

| File | Change |
|---|---|
| `control/src/db/migrations/007_plan_pro.sql` | Widen the check: `ALTER TABLE accounts DROP CONSTRAINT accounts_plan_check, ADD CONSTRAINT accounts_plan_check CHECK (plan IN ('free', 'key_pro', 'student', 'engineer', 'pro'));`. Nothing is removed, so a rollback of the code leaves a valid database. 007 is the next free number (007–008 were reserved for the engine ↔ control link and are unused). Migrations run under the advisory lock before the server listens (`npm start`), so the column accepts `pro` before any webhook can write it. |
| `control/src/billing/stripe.js` | `PLAN_PRICE_ENV` gains `pro: 'STRIPE_PRICE_PRO'` and keeps the three legacy variables, so `planForPrice` still maps existing subscriptions. `SELLABLE_PLANS = ['pro']` decides what checkout accepts. `REQUIRED` becomes the core only (`STRIPE_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BASE_URL`), plus at least one price variable; each price is optional on its own and `config.prices` holds only those set. Today's Railway variables therefore keep billing on, with Pro simply not purchasable yet. |
| `control/src/routes/billing.js` | `POST /v1/billing/checkout` accepts only `SELLABLE_PLANS` (`400 invalid_plan` otherwise, as today) and answers `503 plan_unavailable` when the plan's price variable is unset. `GET /v1/billing` keeps `prices` for every paid plan in `PLANS`, legacy included (an older app still renders its cards) and adds `sellable: ['pro']` filtered to plans whose price is configured. |
| `control/src/auth/capabilities.js` | `PLAN_PLUGINS.pro = SHIPPED_PLUGINS` (the `plansWithoutPlugins` test fails without it). `capabilities.chooseCloud` in `/v1/me` becomes `true` on Free, derived from `plans.js` as now. |
| `control/src/auth/devMode.js` | `DEV_MODE_PLAN = 'pro'`. |
| `control/src/routes/cloud.js` | `cloud_not_in_plan` sentence: "Cloud answers paid by Scope Studio are part of Pro." |
| `control/src/billing/credential.js` | No change. The refusal logic is `platformCloudRefusal` (line 18), keyed on `canAutoCloud` and `platformPaid`, so Free (and Key Pro) are still refused and Pro is served. |
| `control/src/pages/signin.js`, `control/src/notify/index.js` | Dev-mode copy says Pro instead of Engineer. |
| `control/.env.example`, `control/README.md`, `control/API.md` | Document `STRIPE_PRICE_PRO` (optional; Pro is not sold without it), mark the three legacy price variables as "keep set until the last legacy subscription has ended: a webhook for a price with no variable maps to Free", update `/v1/billing`'s shape and the dev-mode plan. |

`/v1/me` and `/v1/cloud/messages` keep their shapes. Nothing in the ledger
changes.

**One compatibility edge to know about.** An engine from before this change
does not know the plan name `pro` and runs it as Free (`knownPlan` in
`server/src/control/plan.js`, by design: an unknown plan grants nothing). So
an account must not become `pro` before its engine is updated. Pro cannot be
bought until `STRIPE_PRICE_PRO` is set, which is the rollout's gate; a
dev-mode device on an old engine sees Free until it pulls.

### 6. UI copy (`client/`)

| File | Change |
|---|---|
| `client/src/components/PlanOverlay.jsx` | Two cards. **Free**: "Unlimited local answers, agents and plug-ins. Add your own Anthropic key for cloud answers and web search, paid on your key." **Pro**: "Everything in Free, plus 270 cloud answers a month paid by Scope Studio, with Opus for the hard ones." A legacy plan's card is shown only to its subscriber, as "Your plan (no longer offered)", with Manage billing. Cards read `sellable` to decide which show a Choose button. |
| `client/src/components/ChatPanel.jsx` | `KEY_PRO_ONLY` sentences become "Needs your own Anthropic key (Sources)". The "N cloud answers left this month" hint shows whenever `answersLeft` is known; today it is hidden when `chooseCloud` is true, which would hide it on Pro. |
| `client/src/components/SourcesOverlay.jsx` | The key field and model choice are shown on every plan; the "Key Pro features" paragraph goes. |
| `client/src/workspace/AgentBuilder.jsx`, `builderForm.js`, `api.js` | No "Needs the Key Pro plan" lock; `own_key_requires_key_pro` → `own_key_not_in_plan` in the error map; `getPlan` keeps reading `chooseCloud`. |
| `client/src/App.jsx` | Comment only ("Key Pro's model choice" → "the model your own key uses"). |
| `server/src/routes/chat.js` | Refusal sentences as in section 2. |

Product docs that describe plans change in the same pull request:
[ARCHITECTURE.md §5](../../ARCHITECTURE.md#5-model-tier-configuration) (the plan
table and "Choosing the cloud is Key Pro only"),
[agent-workspace.md](agent-workspace.md) (`modelPolicy` and the ModelPort
section say "Key Pro"; the benchmark's `scope_local_cloud` arm says "Engineer
plan's rules"), [docs/demo.md](../demo.md) ("Why switch" says own key is a
paid-plan feature), the root `.env.example` (Key Pro comments) and
`control/.env.example`. `docs/legal/terms-of-service.md` and
`privacy-policy.md` name the old plans and prices; their new wording needs
Hynes's review as legal text and can follow separately, but must land before
Pro is sold.

### 7. Tests to change

Tests that encode today's plans change with them; none is deleted without its
behaviour, and each new rule gets a test that would fail without it.

Engine (`server/test`):

- `unit/plans.test.js`: prices and budgets (Pro's $7.37 / month), "choosing
  the cloud yourself" (now Free, Pro and legacy own-key plans), model mixes
  (Pro = Engineer's), the margin test (Pro's 270 answers ≥ 60%), and the
  credential tests split by explicit / Auto. New: Free with a key may choose
  Cloud and web; Pro's Auto goes to the platform and never to the user's key;
  Pro's explicit Cloud uses the user's key and never the platform; past Pro's
  allowance Auto is local even with a key.
- `integration/cloudTier.test.js`: "off Key Pro … is refused" becomes "Free
  may choose Cloud on its own key; without a key it is refused and nothing
  leaves the machine"; the Student and Engineer Auto tests run on `pro`; the
  Key Pro tests run on `free`.
- `unit/workspaceContract.test.js` ("own key is Key Pro with a key"),
  `unit/workspaceAgentsValidation.test.js`, `integration/workspaceAgents.test.js`
  ("own_key is accepted only on the key_pro plan"): own key on any plan with
  `ownKey`, including Free; a test plan without `ownKey` is still refused.
- `integration/usage.test.js`: "absent on an own-key plan" covers Free; Pro
  reports its allowance.
- `integration/controlLink.test.js`, `integration/controlRoutes.test.js`,
  `fakeControl.js`: plan `pro`; `/v1/billing` fake gains `sellable`.
- `unit/control.test.js`: "a plan name the engine does not know is Free" stays
  as is (it is the compatibility guarantee).
- `unit/endurance.test.js`, `integration/endurance.test.js`,
  `unit/taskBenchmark.test.js`: `pro` in place of `engineer` / `student`.

Control plane (`control/test`):

- `unit/billingStripe.test.js`: the price table now includes `pro`; new
  tests that **today's variables** (the three legacy prices, no
  `STRIPE_PRICE_PRO`) keep billing configured with no `pro` price; that
  `STRIPE_PRICE_PRO` alone is enough; that a legacy price still maps to its
  plan; that no price variable at all turns billing off.
- `integration/billing.test.js`: checkout of `pro` opens a session on
  `price_pro`; checkout of `student` is `400 invalid_plan`; checkout of `pro`
  without its variable is `503 plan_unavailable`; a `pro` subscription's
  lifecycle sets and clears `pro`; a legacy subscription's webhook still
  keeps its plan.
- `integration/migrate.test.js`: `accounts.plan` accepts `pro` and still
  rejects an unknown name.
- `integration/cloud.test.js`, `unit/cloudCredential.test.js`: Pro is served
  (Opus for hard, step-down past half the allowance, 270 answers); "Free and
  Key Pro are not paid for by the platform" stays.
- `unit/auth.test.js`, `integration/signin.test.js`: dev mode gives `pro`;
  every plan, `pro` included, lists its plug-ins.

Client (`client/src`):

- `workspace/AgentBuilder.test.jsx` ("offers your own key only on Key Pro"):
  own key offered on Free.
- `workspace/api.test.js`: `getPlan` on Free reports `ownKey: true`.
- A new `PlanOverlay` test: two cards for a Free account, a legacy card only
  for its subscriber, Choose only on `sellable` plans.
- `client/e2e/workspace.spec.js`: its `/api/usage` mock (`chooseCloud:
  false, autoCloud: false`) describes a plan that no longer exists; it
  becomes Free's (`chooseCloud: true, autoCloud: true`).

## Rollout order

1. **Count subscribers** with the query in section 3 and confirm the open
   questions below.
2. **Create the Pro price** in Stripe test mode and set `STRIPE_PRICE_PRO` on
   Railway. Today's control plane does not read it, so this is safe before
   the merge.
3. **Merge the pull request into `dev`.** Railway redeploys `control/`:
   migration 007 runs before the server listens; with today's variables
   billing stays on; Pro becomes purchasable because step 2 set its price;
   legacy plans stop being sold but their subscriptions keep working. Check
   `/health`, then `GET /v1/billing` from a signed-in engine (`sellable:
   ["pro"]`).
4. **Update engines** (`git pull` on each machine that runs one). Until an
   engine is updated it runs a `pro` account as Free; nobody has one yet
   unless they bought it in step 3, so do this before announcing Pro.
5. **Test-mode purchase end to end:** checkout, webhook sets `pro`, an Auto
   hard question is answered by the platform, the portal cancels, the
   webhook returns the account to `free`.
6. **Stripe portal:** allow switching only to Pro; **Key Pro:** set each to
   cancel at period end; **Student / Engineer:** email the offer.
7. **Legal pages** updated and published.
8. **Live mode:** create the live Pro price, set `STRIPE_MODE=live`, the live
   key and `STRIPE_PRICE_PRO` together; billing refuses a mismatched mode and
   key by name.
9. **Clean-up (later, separate PR):** once the last legacy subscription has
   ended, remove the legacy entries from `PLANS` and their price variables.
   The migration's check keeps the old names valid, so this needs no
   database change.

## Open questions for Hynes

- The name of the $20 subscription ("Pro" is proposed) and what it buys
  (proposed: platform-paid, metered cloud answers).
- On Free, should the own key also serve Auto's hard questions (proposed),
  or only the Cloud and web search the user picks?
- Pro's answers and models: 270 a month with Opus for hard questions
  (proposed), or 360 on Sonnet throughout?
- Past Pro's allowance, should Auto fall back to the user's own key when one
  is present? Proposed **no**: spending on someone's key without their
  choosing is a surprise; their explicit Cloud choice still uses it.
- Student and Engineer: grandfather until they choose (proposed), or move them
  to Pro at their next renewal with notice?
- Key Pro: refund the unused part of the period, or let it run out?
