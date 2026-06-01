# AGENTS.md

This file is the repository map for agentic workers. Keep it short. The source
of truth lives in the linked docs.

## Start Here

- Project overview and commands: `README.md`
- Harness operating model: `docs/harness/README.md`
- Current architecture map: `docs/architecture/README.md`
- Quality gates: `docs/harness/quality-gates.md`
- Architecture invariants: `docs/harness/architecture-invariants.md`
- Cleanup cadence: `docs/harness/entropy-cleanup.md`
- Active execution plans: `docs/plans/active/`
- Completed execution plans: `docs/plans/completed/`

## Project Shape

This is a Node.js/TypeScript LiveKit AI interview agent service. Phase 2: the
worker resolves dispatch metadata, joins a LiveKit room, runs an OpenAI realtime
voice session, and writes interview state + transcript through to Redis every
turn. The job tracker is Redis-backed so state survives a child crash. No
reconnect/reseed yet; `REDIS_URL` is required to run the worker.

Core code paths:

- `src/main.ts`: parent worker launcher.
- `src/agent.ts`: LiveKit job entrypoint + per-turn persistence orchestration.
- `src/config/`: env and dispatch metadata validation.
- `src/providers/`: realtime provider routing.
- `src/interview/`: interview prompt construction + pure state/transcript models.
- `src/state/`: Redis connection and the durable store (only Redis-touching code).
- `src/ops/`: logging and job tracking.
- `src/types/`: shared TypeScript contracts.

## Working Rules

- Study the existing code and docs before changing behavior.
- Prefer boring, explicit solutions over clever abstractions.
- Keep `AGENTS.md` as a map; add durable detail under `docs/`.
- Treat `AgentMetadata` as the wire contract and `ResolvedJobConfig` as the
  downstream internal contract.
- Validate external shapes at boundaries; do not let provider or runtime code
  guess wire data.
- Keep LiveKit-specific code out of pure config and prompt-building modules.
- Fail fast with contextual messages; never silently swallow exceptions.
- Preserve structured logging and secret redaction.

## Tests And Verification

Before writing a new test suite, state the intended cases grouped as happy path,
boundaries, invalid input, error paths, and domain-specific edges.

Use the local verification loop:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm harness:check
```

Use `pnpm verify` before committing implementation work.

## Harness Rule

Run `pnpm harness:check` after changing `AGENTS.md`, `README.md`, `package.json`,
`docs/harness/`, `docs/architecture/`, or `docs/plans/`.
