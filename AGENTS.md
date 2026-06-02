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

This is a Node.js/TypeScript LiveKit AI interview agent service. Phase 5: the
worker resolves dispatch metadata, joins a LiveKit room, records to S3 via
LiveKit Egress (S3 preflight, required-vs-degrade per `RECORDING_REQUIRED`), and
runs the interview through a ContextManager that reconnects + reseeds from
durable Redis state on fatal session failure. State + transcript are written
through to Redis every turn; the job tracker is Redis-backed; one final-state
webhook is emitted at the end. The parent worker enforces a per-worker
concurrency cap, drains on SIGTERM, exports OpenTelemetry metrics/traces, and
serves an internal monitoring API. `REDIS_URL` is required.

Core code paths:

- `src/main.ts`: parent worker launcher.
- `src/agent.ts`: LiveKit job entrypoint + per-turn persistence orchestration.
- `src/config/`: env and dispatch metadata validation.
- `src/providers/`: realtime provider routing + Gemini gate.
- `src/interview/`: prompt construction, pure state/transcript/reseed models, and
  the reconnect/reseed ContextManager.
- `src/recording/`: recording controller (required-vs-degrade policy) plus thin
  LiveKit Egress and S3-preflight adapters.
- `src/state/`: Redis connection and the durable store (only Redis-touching code).
- `src/ops/`: logging, job tracking, the final-state webhook, the concurrency
  load function, drain readiness, the metrics interface + OTel adapter, and the
  `monitoring/` API (pure handlers + node:http server).
- `src/types/`: shared TypeScript contracts.
- `k8s/`: production Deployment + Service manifest (`Dockerfile` at the root).

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
