# Control plane API (v1)

The contract between a local engine and the control plane. Paths under `/v1`. JSON in and out
unless noted. This file is the source of truth: change it in the same PR as the code.

## Conventions

**Errors** are `{ "error": "<sentence a person can read>", "code": "<snake_case>" }` with a fitting
status. Driver or upstream error text never reaches the response.

**Device auth.** A signed-in engine sends `Authorization: Bearer <token>`. Tokens look like
`sst_` + 43 base64url characters (32 random bytes). The control plane stores only the SHA-256 hex
of the token (`device_tokens.token_hash`). `requireDevice` (src/middleware/requireDevice.js)
resolves it to `req.account = { id, email, plan, devMode }` and `req.deviceId`, or answers
`401 { code: "unauthenticated" }` for a missing, unknown or revoked token. Every route below marked
**device** uses it. `plan` is the plan the request runs under: `accounts.plan`, or Engineer for a
dev-mode device (see below). A route that needs the billed plan reads `accounts.plan` itself.

**Browser session.** The sign-in and billing pages a person opens in a browser use a cookie
session on the control plane's own domain. They are never called by the engine directly. The
cookie (`scope_control.sid`) is httpOnly, SameSite=Lax and Secure in production; sessions live in
`control_session` and are attached only to the routes that set or read one (register, login,
logout, authorize).

## Accounts and sign-in (Wave 1 · A)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/signin` | — | HTML sign-in / register page. Query: `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`, `label`. |
| POST | `/v1/accounts` | — | Register `{ email, password, dev_mode? }` → `201 { id, email }`. Sets the browser session. `400 invalid_email` / `400 weak_password` (under 10 characters) / `409 email_taken` / `403 dev_mode_not_allowed`. |
| POST | `/v1/auth/login` | — | `{ email, password, dev_mode? }` → `200 { id, email }`. Sets the browser session. `401 invalid_credentials` / `429 too_many_attempts` (10 failures per email in 15 minutes) / `403 dev_mode_not_allowed`. |
| POST | `/v1/auth/logout` | browser | Ends the browser session → `204`. |
| POST | `/v1/auth/authorize` | browser | Called by `/signin` after login: `{ redirect_uri, state, code_challenge, code_challenge_method?, label }` → `{ redirect: "<redirect_uri>?code=…&state=…" }`. One-time code, 5-minute life, stored hashed. `401 unauthenticated` / `400 invalid_redirect_uri` / `400 invalid_code_challenge` (missing, malformed, or a method other than `S256`) / `400 invalid_state`. |
| POST | `/v1/auth/token` | — | Engine exchanges `{ code, code_verifier }` → `{ token, account: { id, email, plan, devMode } }`. The code is single-use; the verifier must hash (S256) to the stored challenge. An unknown, used, expired or wrong-verifier code is one answer, `400 invalid_grant`, and a wrong verifier spends the code. |
| GET | `/v1/me` | device | See below. |
| GET | `/v1/devices` | device | `{ devices: [{ id, label, createdAt, lastUsedAt, current }] }`. |
| DELETE | `/v1/devices/:id` | device | Revokes one of the caller's own devices → `204`. |

`redirect_uri` must be a loopback URL: `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`.
Anything else is rejected with `400 { code: "invalid_redirect_uri" }`.

`/signin` checks the same parameters before showing the forms and answers a `400` page instead
when they are broken, so a password is never typed into a sign-in that cannot finish. Without any
of them it is a plain sign-in page.

**Dev-mode login.** An allowlisted email (`DEV_MODE_EMAILS`, comma-separated, case-insensitive)
may sign in with `dev_mode: true`. Dev mode belongs to the device token it produces
(`device_tokens.dev_mode`), not to the account: that device gets the Engineer plan without a
subscription, `accounts.plan` is never written (billing owns it), and the allowlist is checked
again on every request, so removing an email ends dev mode on its devices at once. The login is
written to `dev_logins` (account, device, email, device label, IP, time) in the same transaction
as the device, and a notification goes to `DEV_LOGIN_NOTIFY_EMAIL` through the notifier interface
(`src/notify`). With no email provider configured the audit row is still written and the
notification is skipped with a logged warning; it never falls back to a default address.

### `GET /v1/me`

```json
{
  "account": { "id": "uuid", "email": "a@b.c", "plan": "student", "devMode": false },
  "capabilities": { "chooseCloud": false, "autoCloud": true, "plugins": ["github", "local_folder"] },
  "limits": {
    "monthlyAnswers": 200, "answersUsed": 12,
    "weeklyAllowanceUsd": 1.02, "weeklySpentUsd": 0.31,
    "freesUpNext": { "amountUsd": 0.04, "at": "2026-10-16T09:12:00Z" }
  },
  "nextModel": { "default": "claude-sonnet-5", "hard": "claude-sonnet-5" },
  "billing": { "status": "active", "renewsAt": "…", "cancelAt": null }
}
```
`capabilities.plugins` lists the plug-ins this plan may use. Every plan gets all shipped plug-ins
today; the field exists so a plug-in can be gated by plan later without an engine release.
`limits` values are `null` on plans without platform-paid cloud. `freesUpNext` is the oldest
ledger row inside the rolling week (its cost, and when it leaves the window), or `null`.
`weeklyAllowanceUsd` is rounded to the cent; spend figures to four decimal places. `nextModel` is
what the next platform answer would use, already stepped down past half the week's allowance;
both values are `null` on Free. `billing` values are `null` until a subscription exists.

## Billing (Wave 1 · B)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/billing` | device | `{ plan, status, renewsAt, cancelAt, prices: { key_pro, student, engineer } }` (prices in USD). |
| POST | `/v1/billing/checkout` | device | `{ plan }` → `{ url }` (Stripe Checkout, Managed Payments). `409 { code: "already_subscribed" }`. |
| POST | `/v1/billing/portal` | device | → `{ url }` (Stripe customer portal). |
| POST | `/v1/billing/webhook` | Stripe signature | Raw body, mounted before the JSON parser. Snapshot events: `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`. Each re-reads the subscription from Stripe. |

Checkout and portal return to `BASE_URL/billing/done`, a small page that tells the person to
return to the app.

## Platform cloud (Wave 1 · C)

`POST /v1/cloud/messages` · device

Request:
```json
{
  "requestId": "uuid from the engine, reused on retry",
  "messages": [{ "role": "system" | "user" | "assistant", "content": "…" }],
  "cacheMarker": "optional, as the engine's streamChat takes it",
  "hard": false,
  "sources": ["github"]
}
```
`sources` names the plug-ins whose nodes are in the packed context (`github`, `local_folder`,
later `kicad`, `zotero`, …). It is stored on the ledger row so cost per answer can be measured per
plug-in. Unknown names are accepted (plug-ins ship in the engine first); at most 16, each
`^[a-z][a-z0-9_]{0,31}$`, else `400 { code: "invalid_sources" }`.

The control plane decides everything else: whether the plan may use platform cloud, model
(`plans.js` lives here as the authority), effort, `max_tokens`, economy/brevity. Web search is
never available here (it is Key Pro only, on the user's own key, called from the engine).

Refusals happen before any upstream call, as JSON:
- `403 { code: "cloud_not_in_plan" }` — Free or Key Pro (Key Pro uses its own key locally).
- `402 { code: "answer_limit_reached" }` / `402 { code: "allowance_exhausted" }` — include
  `freesUpNext` where it applies.
- `503 { code: "platform_cloud_unavailable" }` — no platform key configured.
- `409 { code: "duplicate_request" }` — `requestId` already recorded.

Success is `text/event-stream`. Each event is `data: <json>\n\n`, mirroring the engine's
`streamChat` yields so the engine can swap generators without touching the chat route:
- `{ "text": "…" }` — repeated.
- `{ "done": true, "usage": { "input_tokens", "output_tokens", … }, "stopReason": "end_turn",
     "model": "claude-sonnet-5", "costUsd": 0.0123, "economy": false }` — last on success.
- `{ "error": "<sentence>", "code": "upstream_error" }` — last on failure after streaming began.

The ledger row is written once, when the upstream message completes, with the request id.
Prompt and answer text are never logged or stored.
