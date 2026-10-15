# Control plane API (v1)

The contract between a local engine and the control plane. Paths under `/v1`. JSON in and out
unless noted. This file is the source of truth: change it in the same PR as the code.

## Conventions

**Errors** are `{ "error": "<sentence a person can read>", "code": "<snake_case>" }` with a fitting
status. Driver or upstream error text never reaches the response.

**Device auth.** A signed-in engine sends `Authorization: Bearer <token>`. Tokens look like
`sst_` + 43 base64url characters (32 random bytes). The control plane stores only the SHA-256 hex
of the token (`device_tokens.token_hash`). `requireDevice` (src/middleware/requireDevice.js)
resolves it to `req.account = { id, email, plan }` and `req.deviceId`, or answers
`401 { code: "unauthenticated" }` for a missing, unknown or revoked token. Every route below marked
**device** uses it.

**Browser session.** The sign-in and billing pages a person opens in a browser use a cookie
session on the control plane's own domain. They are never called by the engine directly.

## Accounts and sign-in (Wave 1 · A)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/signin` | — | HTML sign-in / register page. Query: `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`, `label`. |
| POST | `/v1/accounts` | — | Register `{ email, password }` → `201 { id, email }`. Sets the browser session. |
| POST | `/v1/auth/login` | — | `{ email, password }` → `200 { id, email }`. Sets the browser session. |
| POST | `/v1/auth/logout` | browser | Ends the browser session. |
| POST | `/v1/auth/authorize` | browser | Called by `/signin` after login: `{ redirect_uri, state, code_challenge, label }` → `{ redirect: "<redirect_uri>?code=…&state=…" }`. One-time code, 5-minute life. |
| POST | `/v1/auth/token` | — | Engine exchanges `{ code, code_verifier }` → `{ token, account: { id, email, plan } }`. The code is single-use; the verifier must hash (S256) to the stored challenge. |
| GET | `/v1/me` | device | See below. |
| GET | `/v1/devices` | device | `{ devices: [{ id, label, createdAt, lastUsedAt, current }] }`. |
| DELETE | `/v1/devices/:id` | device | Revokes one of the caller's own devices → `204`. |

`redirect_uri` must be a loopback URL: `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`.
Anything else is rejected with `400 { code: "invalid_redirect_uri" }`.

**Dev-mode login.** An allowlisted email (`DEV_MODE_EMAILS`, comma-separated) may sign in with
`dev_mode: true`. The account gets the Engineer plan without a subscription, the login is written
to an audit table (account, device label, IP, time), and a notification goes to
`DEV_LOGIN_NOTIFY_EMAIL` through the notifier interface. With no email provider configured the
audit row is still written and the notification is skipped with a logged warning; it never
falls back to a default address.

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
`^[a-z][a-z0-9_]{0,31}$`, else `400 { code: "invalid_sources" }`. Repeated names are stored once.

Field rules (else `400 { code: "invalid_request" }`, naming the field, never echoing content):
- `requestId`: string, 8–128 characters. Unique across the whole ledger, not per account.
- `messages`: non-empty; each is exactly `{ role, content }`; `content` is a string or a non-empty
  array of Anthropic content blocks of type `text`, `image` or `document` (no tool blocks: no tools
  are offered). At most one `system` message, text only; at least one `user` message.
- `cacheMarker`: optional string, at most 256 characters. `hard`: optional boolean, default `false`.

The control plane decides everything else: whether the plan may use platform cloud, model
(`plans.js` lives here as the authority), effort, `max_tokens`, economy/brevity. Web search is
never available here (it is Key Pro only, on the user's own key, called from the engine). Any
field not listed above — `model`, `max_tokens`, `effort`, `output_config`, `tools`,
`tool_choice`, `webSearch`, or anything else — is refused with `400 { code: "field_not_allowed" }`
rather than ignored.

Model and ceiling follow `plans.js`: the plan's model for `hard` or not; from half the week's
allowance spent (`economy`), Opus steps down to Sonnet, `max_tokens` drops from 2,048 to 700 and
a brevity note is appended after the cache breakpoint.

Refusals happen before any upstream call, as JSON, checked in this order:
1. `403 { code: "cloud_not_in_plan" }` — Free or Key Pro (Key Pro uses its own key locally).
2. `503 { code: "platform_cloud_unavailable" }` — no platform key configured
   (`PLATFORM_ANTHROPIC_API_KEY`).
3. `409 { code: "duplicate_request" }` — `requestId` already recorded, or streaming right now.
4. `402 { code: "answer_limit_reached", freesUpNext: { answers: 1, at } }` — the rolling 30 days
   hold the plan's monthly answers; `at` is when the oldest of them ages out (`null` if none).
5. `402 { code: "allowance_exhausted", freesUpNext: { amountUsd, at } }` — the rolling week's spend
   has reached the weekly allowance; same `freesUpNext` as `GET /v1/me`.
6. `429 { code: "too_many_streams" }` — two answers are already streaming for this account. The
   cap also bounds how far concurrent answers can overshoot the allowance (each passed the check
   before any was charged). It is counted per control plane instance.

Success is `text/event-stream`, headers flushed at once. Each event is `data: <json>\n\n`,
mirroring the engine's `streamChat` yields so the engine can swap one answer stream for the other
without touching the chat route:
- `{ "text": "…" }` — repeated.
- `{ "done": true, "usage": { "input_tokens", "output_tokens", "cache_creation_input_tokens",
     "cache_read_input_tokens" }, "stopReason": "end_turn", "model": "claude-sonnet-5",
     "costUsd": 0.0123, "economy": false }` — last on success. `costUsd` includes cache writes
  (1.25× input) and reads (0.1× input).
- `{ "error": "<sentence>", "code": "upstream_error" }` — last on failure after streaming began.
  The sentence is chosen from the kind of failure; upstream error text never reaches the engine.

The ledger row is written once per request id, before the `done` event is sent, so the next
request is checked against it. `input_tokens` on the row is everything the model read (fresh,
cache write and cache read); `cost_usd` prices each part. An answer that fails or whose client
hangs up mid-stream is still charged: hanging up aborts the upstream call, and the row records the
input counts the stream reported plus the larger of the reported output and an estimate from the
streamed text (3 characters a token), so platform spend is never under-counted. Prompt and answer
text are never logged or stored.
