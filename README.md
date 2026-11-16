# Scope Studio

A backend that stores engineering context as a graph and returns a small,
relevant slice of it for a question. I started it because I was tired of
re-explaining my projects to AI tools at the start of every session.

**Studio:** Fourier Studios
**Status:** Backend retrieval v1. No working frontend, no model routing, no
benchmark results.

## What exists

All of it is in `server/`, written in September 2026.

- **A graph store on PostgreSQL with pgvector.** Nodes have a type (repo, file,
  decision, spec, paper, datasheet, conversation), a 768-dimension embedding
  under an HNSW index, and typed relationships to other nodes: `depends_on`,
  `references`, `supersedes`, `caused_by`, `part_of`.
- **Hybrid retrieval.** A dense search over the embeddings and a lexical search
  over a `tsvector` column, merged with Reciprocal Rank Fusion.
- **Scoring.** Recency decay per node type, a boost for the active project, a
  task-type boost from a centroid classifier, and demotion of any node that a
  newer one supersedes.
- **Graph expansion.** One forward hop from the top-scoring results, so a
  related node can be returned even when it does not match the query text.
- **Token-budget packing.** Each node stores an estimated token length, its
  character count divided by four, and results are packed greedily into a
  budget. The default tier allows 1,500 estimated tokens and 5 nodes.
- **GitHub ingestion over OAuth.** After the OAuth flow it lists the signed-in
  user's repositories and stores one node per repository, holding the name and
  description, with incremental sync by update time.
- **Query metrics.** Each query logs its latency, the tokens it returned, the
  tokens available in the store, and which nodes were chosen. A feedback route
  marks a result as useful.
- **Accounts.** Session auth with hashed passwords.

Embeddings come from `nomic-embed-text` running in Ollama. Nodes other than
repositories, and every relationship, are created through the `/api/nodes`
routes.

## What does not exist

- **A frontend.** `client/` is a React and Vite chat shell that keeps messages
  in local state. It does not call the backend.
- **Model routing.** Nothing here calls a language model. The backend returns
  context and stops. The two retrieval tiers, local and cloud, are parameter
  sets for retrieval. The metrics table has routing columns and nothing writes
  to them.
- **Benchmark results.** There is a `benchmark_runs` table and a benchmark plan
  in `ARCHITECTURE.md`. No benchmark has been run.
- **GitHub file ingestion.** Repository names and descriptions are pulled in.
  File contents are not.
- **Automated tests and CI.**

## What has not been measured

Any efficiency number. The backend computes tokens returned against tokens
available for each query, but I have not run it over a query set. I make no
claim here about token savings, latency or answer quality.

`ARCHITECTURE.md` records the design and the reasoning behind it. Its targets,
such as the token reduction and the 300 ms retrieval budget, are design targets
and are labeled there as unmeasured.

## Repository history

The pull request history goes further than `main`. Between September and
November 2026 I built a much larger version on a separate branch: agents,
model routing, a web interface and more. I set it aside and did not merge it
here. When I made this repository public I deleted those branches, so `main`,
`dev` and `test` hold only what this README describes. The merged pull
requests still show that work, but none of it is on `main`, and nothing in
this README depends on it.

## Stack

- **Backend:** Node.js and Express
- **Database:** PostgreSQL with pgvector
- **Embeddings:** `nomic-embed-text` through Ollama
- **Client shell:** React and Vite, not connected to the backend

## Project structure

| Path | Contents |
|---|---|
| `server/` | The backend: routes, retrieval, the GitHub plugin, migrations |
| `client/` | The unconnected chat shell |
| `ARCHITECTURE.md` | Design decisions and the benchmark plan |

## Setup

1. Copy `.env.example` to `server/.env` and fill in the required values.
2. Run `npm install` in `server/`.
3. Run `npm run migrate` to create the schema. PostgreSQL needs the pgvector
   extension available.
4. Run `npm run dev` to start the server.

`npm run embed` backfills embeddings for nodes that were created while Ollama
was unreachable, and `npm run centroids` builds the task-type centroids.
