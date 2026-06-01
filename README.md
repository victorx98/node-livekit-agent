# LiveKit AI Interview Agent Service

Node.js / TypeScript LiveKit AI Interview Agent worker. See
[`livekit_ai_interview_agent_design_v3.md`](./livekit_ai_interview_agent_design_v3.md)
for the full system design.

## Status: Phase 0 — Skeleton + contract

This phase locks the **config contract** before anything depends on it. No
LiveKit is wired yet.

**Implemented**

- Repo scaffold (TypeScript, pnpm, Docker) following the §5 layout.
- Authoritative dispatch contract `AgentMetadata` verbatim (§8.1) — `src/types/job.ts`.
- Internal `ResolvedJobConfig` adapter shape (§8.2) — `src/types/config.ts`.
- `resolveJobConfig` adapter with zod validation (§8.3–§8.4) — `src/config/`.
- Operational env loading (§7) — `src/config/env.ts`.
- Structured `pino` logger with secret redaction (§20–§21) — `src/ops/logger.ts`.
- Bootstrap entrypoint — `src/main.ts`.

**Not in Phase 0** (later phases): the LiveKit supervisor/worker, provider
routing, interview orchestration, Redis state, recording/Egress, monitoring API,
webhooks, telemetry, graceful draining.

## Requirements

- Node.js 20+ (developed on 22)
- pnpm (via `corepack enable pnpm`)

## Commands

```bash
pnpm install        # install dependencies
pnpm test           # run the unit test suite (vitest)
pnpm test:watch     # watch mode
pnpm typecheck      # tsc --noEmit
pnpm build          # compile to dist/
pnpm lint           # eslint
pnpm format         # prettier --write

# run the Phase 0 bootstrap (loads env, logs, exits)
node --env-file=.env dist/main.js
```

## Config model

`AgentMetadata` (the wire contract, §8.1) is the source of truth. The rest of
the service consumes `ResolvedJobConfig` (§8.2). `resolveJobConfig` is the only
module that knows the wire shape — it validates with zod and maps per the §8.3
table.

In production the LiveKit worker calls it as
`resolveJobConfig(ctx.job?.metadata ?? "{}", ctx.job?.id ?? ctx.room.name)`. The
function is kept pure (string + job id in) so the contract is fast to unit-test
and the LiveKit dependency stays out of the core.

Copy `.env.example` to `.env` and fill in values as subsystems are wired.
