# LiveKit AI Interview Agent Service

Node.js / TypeScript LiveKit AI Interview Agent worker. See
[`livekit_ai_interview_agent_design_v3.md`](./livekit_ai_interview_agent_design_v3.md)
for the full system design.

## Status: Phase 1 — Walking skeleton (a talking interviewer)

A minimal worker that joins a LiveKit room, seeds the interviewer from dispatch
metadata, runs an OpenAI realtime session, and exits on room end. This de-risks
the hardest thing: LiveKit + realtime audio + the prompt actually conducting an
autonomous spoken interview.

**Implemented (Phase 1)**

- LiveKit worker launcher (`src/main.ts`) + agent job module (`src/agent.ts`).
- Provider routing — OpenAI realtime wired, Gemini gated (§11/§15) — `src/providers/`.
- Instruction builder (§12) — `src/interview/buildInstructions.ts`.
- In-memory job tracker (§17 interface; no Redis) — `src/ops/jobTracker.ts`.
- Dispatch helper for manual testing — `scripts/dispatch.mjs`.

**From Phase 0 (still here)**

- `AgentMetadata` wire contract (§8.1), `ResolvedJobConfig` (§8.2),
  `resolveJobConfig` + zod validation (§8.3–§8.4), env loading (§7),
  `pino` logger with secret redaction (§20–§21).

**Not yet** (later hardening phases): Redis state + transcript, reconnect/reseed,
S3 recording/Egress, monitoring API, webhooks, telemetry, concurrency cap,
graceful draining.

> **API note:** the OpenAI realtime model id is **`gpt-realtime`** (voice
> `marin`); the design doc's `gpt-realtime-2` does not exist in the installed
> `@livekit/agents-plugin-openai@1.4.4`.

## Run a live interview (Phase 1 verification)

Prerequisites: a LiveKit project (Cloud or self-hosted) and an OpenAI key.

1. `cp .env.example .env` and fill in `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
   `LIVEKIT_API_SECRET`, and `OPENAI_API_KEY`.
2. Build and start the worker (registers under `AGENT_NAME`, default
   `interview-agent`):
   ```bash
   pnpm build
   pnpm dev          # node --env-file=.env dist/main.js dev
   ```
3. In another terminal, dispatch a job with sample interview metadata and get a
   candidate token:
   ```bash
   pnpm dispatch     # node --env-file=.env scripts/dispatch.mjs
   ```
4. Open https://agents-playground.livekit.io/, connect **manually** with the
   printed server URL + candidate token, and start talking. The agent greets you
   and works through the dispatched questions.

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

pnpm dev            # run the worker (dev mode); needs .env with LiveKit + OpenAI creds
pnpm start          # run the worker (production mode)
pnpm dispatch       # create a test dispatch + print a candidate token
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
