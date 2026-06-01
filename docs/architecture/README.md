# Architecture

This repository implements a Node.js/TypeScript LiveKit AI interview agent.
Phase 2 adds durable state: the worker proven in Phase 1 now writes interview
state and transcript through to Redis on every turn, and the job tracker is
Redis-backed so job state survives a child-process crash. No reconnect/reseed
yet.

## Runtime Flow

```text
External backend
  -> LiveKit dispatch metadata
  -> LiveKit worker process (`src/main.ts`)
  -> job entrypoint (`src/agent.ts`)
  -> config resolver (`src/config/resolveConfig.ts`)
  -> prompt builder (`src/interview/buildInstructions.ts`)
  -> provider router (`src/providers/createRealtimeModel.ts`)
  -> realtime voice session
       -> per turn: deterministic state (`src/interview/interviewState.ts`)
          + transcript write-through to Redis (`src/state/redisStore.ts`)
  -> Redis-backed job tracker (`src/ops/jobTracker.ts` -> `src/state/redisStore.ts`)
```

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
  (write-through). `REDIS_URL` is required to run the worker from Phase 2 on.
- State is persisted but not yet consumed: reconnect/reseed from Redis is
  Phase 3. `finalize` sets a TTL on completion; a crash skips it so data
  survives for recovery.
- Recording, monitoring API, webhooks, telemetry, concurrency caps, and graceful
  draining are deferred.
- `resolveJobConfig` and the interview state/transcript models are intentionally
  pure so they can be tested without LiveKit or Redis runtime dependencies.

## Extension Points

- Add reconnect/reseed by reading `InterviewState` from `RedisStore` and
  rebuilding the session seed (Phase 3); state is already persisted per turn.
- Add recording under a dedicated `src/recording/` module so LiveKit egress and
  S3 policy stay separate from `src/agent.ts`.
- Add monitoring and load management under `src/ops/`.
- Add provider implementations under `src/providers/`, keeping duration gates
  and capability checks explicit.

See `docs/harness/architecture-invariants.md` for the rules that keep these
boundaries enforceable.
