# Scope Studio

A persistent, token-efficient engineering context layer that routes queries
to the right model with the minimum necessary knowledge. Built for engineers
and STEM researchers who work across multiple tools, codebases, and projects
and are tired of re-explaining context to AI tools on every session.

**Studio:** Fourier Studios
**Status:** Pre-build

## Core differentiators

1. **Neural map** — a structured knowledge graph of engineering artifacts and
   their relationships, not a flat vector database
2. **Token efficiency** — retrieves the minimum connected subgraph that
   answers a query, not everything related to the topic
3. **Intelligent routing** — automatically routes between a local Ollama
   model and a cloud API based on context size, privacy flags, and task
   complexity
4. **Plugin architecture** — connects to major engineering and research
   tooling via a standardized connector interface

## Stack

- **Frontend:** React + Vite
- **Backend:** Node.js + Express
- **Database:** PostgreSQL with pgvector
- **Embedding model:** Nomic Embed via Ollama
- **Local inference:** Ollama (Qwen2.5:7b / Qwen3.6)
- **Cloud fallback:** Anthropic API or OpenAI (user-supplied key, never stored server-side)

## Project structure

```
scope-studio/
├── client/     React + Vite frontend
├── server/     Node + Express backend
├── dev-notes/
│   └── handoffs/   Session handoff notes (gitignored)
└── README.md
```

## Setup

1. Copy `.env.example` to `.env` and fill in the required values.
2. `npm install` in both `client/` and `server/`.
3. See `dev-notes/` for the current sprint plan.
