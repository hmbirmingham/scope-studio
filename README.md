# scope

A personal CLI that runs local agents on one laptop. Not a product, not a Claude
replacement — a tool for automating a student workflow, and a way to learn AI
engineering, UI/UX and CI/CD by building something I actually use.

**Status:** phase 0. The CLI runs a task end to end against a local model, checks the
result, and records the run in my notes vault.

## What it is

Agents do the long, repetitive work — research, filing, project logistics, pulling
internship postings — on local models, so the cloud subscription I already pay for is
spent only on the steps that need judgement. Work is allowed to take longer. It is not
allowed to come back wrong.

Three ideas carry the design:

**Every step has a check before it has a model.** A step nobody can check is a question
for me, not a task, and the task loader refuses one without gates. Deterministic gates
run first because they are free and unarguable — but they verify *shape*, not truth, so
they are a floor, not a guarantee. A rubric judge follows, from one file that holds both
the prose the generator is given and the lines the judge checks, so the two cannot drift.

**The vault is a format, not a tool.** Notes are plain markdown with YAML frontmatter and
`[[wikilinks]]` on local disk. Obsidian opens them and git diffs them, and nothing here
calls an Obsidian API or needs it running. The agent writes only under `scope/`, prefers
new files to edits, and commits after every write — that commit is the only undo a
clobbered editor buffer has.

**Cloud is rationed.** No API keys. Cloud means headless Claude Code on the subscription,
capped at a fraction of a day's usage, spent on planning hard tasks and on the final gate
for anything that leaves the machine. Everything else is local or queued.

## Layout

```
cli/        the scope CLI — zero dependencies
server/     local engine: graph retrieval, routing, GitHub ingest (being ported into cli/)
dev-notes/  plans and session handoffs
```

## Setup

```bash
cd cli && ./bin/scope.js doctor
```

`doctor` reports everything this depends on and the exact command to fix each gap:
Ollama and the local model, the vault and whether it is a git repo, `claude` on PATH,
the cloud budget, and the Docker daemon.

Then:

```bash
./bin/scope.js init                 # create the agent's directories in the vault
./bin/scope.js run <task> --verbose # run a task, show every gate
```

A task is a markdown file in `<vault>/scope/tasks/`:

```markdown
---
id: rag-eval-brief
attempts: 3
---
## Task
How do people evaluate RAG retrieval quality?

## Gates
- cited: every_paragraph_matches \[\d+\]
- length: max_words 400
- no-filler: no_placeholder
```

The local engine in `server/` needs `.env` filled from `.env.example` and a local
Postgres with pgvector; see `dev-notes/plans/` for where it is going.

## History

This was Scope Studio, a product with tiers and billing. That is over — see
`dev-notes/plans/2026-10-29-pivot-personal-agent-cli.md`. The pre-pivot tree is tagged
`archive/product-v1`.
