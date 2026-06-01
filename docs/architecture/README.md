# Architecture

This repository implements a Node.js/TypeScript LiveKit AI interview agent.
Phase 3 adds reconnect + reseed on top of durable state: the interview runs
through a ContextManager that opens a fresh realtime session reseeded from the
Redis recap when a session fails fatally, so context is never lost.

## Runtime Flow

```text
External backend
  -> LiveKit dispatch metadata
  -> LiveKit worker process (`src/main.ts`)
  -> job entrypoint (`src/agent.ts`)
  -> config resolver (`src/config/resolveConfig.ts`)
  -> prompt builder (`src/interview/buildInstructions.ts`)
  -> provider router (`src/providers/createRealtimeModel.ts`)
  -> reconnect controller (`src/interview/contextManager.ts`)
       -> realtime voice session (rebuilt + reseeded on fatal failure from
          `src/interview/reseed.ts` using durable state)
       -> per turn: deterministic state (`src/interview/interviewState.ts`)
          + transcript write-through to Redis (`src/state/redisStore.ts`)
  -> Redis-backed job tracker (`src/ops/jobTracker.ts` -> `src/state/redisStore.ts`)
```

The OpenAI plugin reconnects transient socket drops itself (replaying in-memory
context). The ContextManager handles the fatal path: when `AgentSession` closes
with `CloseReason.ERROR`, it opens a new session seeded with instructions + a
recap from durable state, up to `RECONNECT_MAX_RETRIES`.

## Modules

- `src/main.ts`: launches the LiveKit Agents CLI parent process.
- `src/agent.ts`: orchestrates one LiveKit job from connect to completion.
- `src/config/env.ts`: reads operational environment values.
- `src/config/schema.ts`: validates dispatch metadata with Zod.
- `src/config/resolveConfig.ts`: adapts wire metadata to `ResolvedJobConfig`.
- `src/config/sampleMetadata.ts`: test and manual-dispatch sample data.
- `src/interview/buildInstructions.ts`: builds the autonomous interview seed.
- `src/interview/interviewState.ts`: pure deterministic interview-state model
  and reducers (recent-turns ring buffer, turn stats).
- `src/interview/transcriptStore.ts`: transcript event shape and chat-role
  mapping (pure).
- `src/interview/reseed.ts`: pure builder for the reseed context (instructions +
  recap of covered/pending questions and recent turns).
- `src/interview/contextManager.ts`: reconnect/reseed controller driven by
  injected effects (session factory, reconnect callback); includes a no-op
  rotation hook.
- `src/providers/createRealtimeModel.ts`: gates providers and creates OpenAI
  realtime models.
- `src/state/redisClient.ts`: lazy process-wide ioredis connection.
- `src/state/redisStore.ts`: the only Redis-touching module — interview state,
  transcript, and job-record persistence plus finalize TTL.
- `src/ops/jobTracker.ts`: async job tracking interface, in-memory and
  Redis-backed implementations.
- `src/ops/logger.ts`: structured Pino logger with secret redaction.
- `src/types/config.ts`: internal resolved configuration contract.
- `src/types/job.ts`: dispatch metadata and job-related wire types.
- `src/types/tracker.ts`: shared job-record/status contracts.

## Current Constraints

- OpenAI realtime is wired; Gemini remains gated until its long-session behavior
  is verified.
- Job state, interview state, and transcript are persisted to Redis
  (write-through). `REDIS_URL` is required to run the worker.
- Reconnect/reseed is implemented: fatal session failures rebuild a fresh
  session from the durable recap, up to `RECONNECT_MAX_RETRIES`. Proactive
  rotation of a healthy session is deferred (no-op hook in the ContextManager).
- The duration cap (`min(durationMins, 59)`) and the `assertProviderAllowed`
  Gemini gate bound every run.
- Recording, monitoring API, webhooks, telemetry, concurrency caps, and graceful
  draining are deferred.
- `resolveJobConfig`, the interview state/transcript/reseed models, and the
  ContextManager loop are intentionally pure or injected-effect so they can be
  tested without LiveKit or Redis runtime dependencies.

## Extension Points

- Add recording under a dedicated `src/recording/` module so LiveKit egress and
  S3 policy stay separate from `src/agent.ts`.
- Add monitoring and load management under `src/ops/`.
- Add provider implementations under `src/providers/`, keeping duration gates
  and capability checks explicit.

See `docs/harness/architecture-invariants.md` for the rules that keep these
boundaries enforceable.
