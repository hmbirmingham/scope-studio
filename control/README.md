# Scope Studio control plane

The hosted half of Scope Studio. It holds what a user's machine must never see: accounts and
plans, Stripe billing and the platform's Anthropic key. Retrieval, the map, Ollama, actions and
private data stay in the local engine (`server/`).

## Local

```
createdb scope_control_dev && createdb scope_control_test
cp .env.example .env   # fill in both database URLs
npm install
npm run migrate
npm run dev            # http://localhost:3101/health
npm test
```

## Railway

One service in the project that holds the Postgres database, so it reaches it over the private
network.

- Source: this repo, branch `dev` (staging until launch), **Root Directory `control`**.
- `railway.json` here sets the rest: migrations run before each deploy, then `npm start`, and
  traffic switches only once `/health` answers 200 (it checks the database).
- Variables: `DATABASE_URL = ${{Postgres.DATABASE_URL}}`. Later phases add the platform key and
  Stripe; each is listed in `.env.example` when it is needed. Nothing has a default.

## What it stores

`usage_ledger` records what each platform-paid answer cost: tokens, model, cost. It has no column
for a prompt or an answer, and a test fails if one is added.
