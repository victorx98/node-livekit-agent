# LiveKit AI Interview Agent Service

Node.js / TypeScript LiveKit AI Interview Agent worker. See
[`livekit_ai_interview_agent_design_v3.md`](./livekit_ai_interview_agent_design_v3.md)
for the full system design.

## Harness engineering

Agent-facing repository guidance starts in [`AGENTS.md`](./AGENTS.md). The
harness operating model lives in
[`docs/harness/README.md`](./docs/harness/README.md), and the current service
architecture map lives in
[`docs/architecture/README.md`](./docs/architecture/README.md).

Run `pnpm verify` before committing implementation work. It runs linting,
typechecking, tests, and the harness structure check.

## Status: Phase 3 — Reconnect + reseed (never lose context)

The interview runs through a **ContextManager**. The OpenAI plugin already
reconnects transient socket drops (replaying its in-memory context); when a
session fails *fatally* (the plugin exhausts its retries and `AgentSession`
closes with `CloseReason.ERROR`), the ContextManager opens a fresh realtime
session **reseeded from the durable Redis recap** (covered/pending questions +
recent turns) and continues — up to `RECONNECT_MAX_RETRIES`, then fails the job.

**Implemented (Phase 3)**

- Pure reseed builder (instructions + recap from state) — `src/interview/reseed.ts`.
- Reconnect/reseed controller, injected-effect and fault-injectable —
  `src/interview/contextManager.ts`.
- Wired into `src/agent.ts`; `RECONNECT_MAX_RETRIES` in `src/config/env.ts`.
- Duration cap (`min(durationMins, 59)`) and the `assertProviderAllowed` Gemini
  gate bound every run (carried from Phase 1, confirmed).

**From earlier phases**

- LiveKit worker + agent, OpenAI realtime (Gemini gated), instruction builder,
  durable Redis state + transcript + job tracker, the
  `AgentMetadata`→`ResolvedJobConfig` contract, env loading, redacting logger.

**Not yet** (later phases): proactive session rotation (no-op hook), S3
recording/Egress, monitoring API, webhooks, telemetry, concurrency cap, graceful
draining.

> **API note:** the OpenAI realtime model id is **`gpt-realtime`** (voice
> `marin`); the design doc's `gpt-realtime-2` does not exist in the installed
> `@livekit/agents-plugin-openai@1.4.4`.

## Run a live interview (verification)

Prerequisites: a LiveKit project (Cloud or self-hosted), an OpenAI key, and a
Redis instance (`REDIS_URL`, required from Phase 2 on).

1. `cp .env.example .env` and fill in `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
   `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, and `REDIS_URL`.
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

### Inspect durable state (Phase 2 acceptance)

While an interview is running, watch state and transcript grow in Redis:

```bash
redis-cli KEYS 'iv:*'                      # interview state + transcript keys
redis-cli LRANGE iv:<jobId>:transcript 0 -1
redis-cli GET iv:<jobId>:state
redis-cli SMEMBERS jobs                    # tracked job ids
```

Kill the worker child mid-call (e.g. `pkill -f dist/agent` or stop the process);
the keys remain in Redis (no TTL is applied on a crash), so a future reseed can
recover. `scripts/redis-smoke.mjs` exercises the same store against a real Redis
without LiveKit if you want a quick, credential-free check:

```bash
REDIS_URL=redis://localhost:6379 node scripts/redis-smoke.mjs
```

### Reconnect + reseed (Phase 3 acceptance)

The reconnect/reseed logic is proven by a **deliberate fault-injection unit
test** that needs no credentials — a fake session factory fails N times, and the
controller is asserted to reseed (recap carried), count reconnects, and give up
after the cap:

```bash
pnpm test src/interview/contextManager.test.ts
```

Live: during an interview, force a disconnect. A transient socket drop is
recovered by the OpenAI plugin (context replayed from memory). A *fatal* failure
(plugin retries exhausted) makes `AgentSession` close with `CloseReason.ERROR`;
the worker logs `provider_reconnect_started` / `provider_reconnect_completed`,
opens a fresh session seeded with the recap, and the agent continues from where
it left off. Tune `RECONNECT_MAX_RETRIES` to bound the attempts.

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
