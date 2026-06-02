# Architecture

This repository implements a Node.js/TypeScript LiveKit AI interview agent.
Phase 5 adds the production-ops layer: an explicit per-worker concurrency cap, a
drain-aware shutdown, OpenTelemetry metrics/traces, and a small internal
monitoring API — on top of recording + webhook, reconnect + reseed, and durable
state.

## Runtime Flow

```text
External backend
  -> LiveKit dispatch metadata
  -> LiveKit worker process (`src/main.ts`)
       -> concurrency cap (`src/ops/loadFunc.ts`) + drain readiness
          (`src/ops/readiness.ts`) + telemetry (`src/ops/telemetry.ts`)
       -> monitoring API on its own port (`src/ops/monitoring/server.ts`
          -> `src/ops/monitoring/handlers.ts`)
  -> job entrypoint (`src/agent.ts`)  [child process; emits per-job metrics]
  -> config resolver (`src/config/resolveConfig.ts`)
  -> prompt builder (`src/interview/buildInstructions.ts`)
  -> provider registry (`src/providers/registry.ts`)
  -> recording: S3 preflight + LiveKit Egress (`src/recording/recorder.ts`
       -> `src/recording/s3Preflight.ts` + `src/recording/egressGateway.ts`)
  -> reconnect controller (`src/interview/contextManager.ts`)
       -> realtime voice session (rebuilt + reseeded on fatal failure from
          `src/interview/reseed.ts` using durable state)
       -> per turn: deterministic state (`src/interview/interviewState.ts`)
          + transcript write-through to Redis (`src/state/redisStore.ts`)
  -> Redis-backed job tracker (`src/ops/jobTracker.ts` -> `src/state/redisStore.ts`)
  -> teardown: stop egress + one final-state webhook (`src/ops/webhook.ts`)
```

Provider plugins may reconnect transient socket drops themselves. The
ContextManager handles the fatal path: when `AgentSession` closes with
`CloseReason.ERROR`, it opens a new session seeded with instructions + a recap
from durable state, up to `RECONNECT_MAX_RETRIES`.

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
- `src/providers/registry.ts`: selects the configured realtime provider and
  creates a LiveKit-compatible realtime model.
- `src/providers/openai.ts` / `src/providers/google.ts`: provider-specific
  policy and LiveKit plugin option mapping.
- `src/recording/recordingPlan.ts`: pure resolver for the Egress filepath from
  `recordingKey` (and the file extension from `audio_only`).
- `src/recording/recorder.ts`: recording controller — owns the
  required-vs-degrade policy and safe stop; driven by an injected S3 preflight
  thunk and EgressGateway (no LiveKit/AWS imports).
- `src/recording/egressGateway.ts`: the only LiveKit Egress adapter (Room
  Composite to S3).
- `src/recording/s3Preflight.ts`: the only S3 adapter (HeadBucket -> PutObject
  -> DeleteObject preflight).
- `src/ops/webhook.ts`: pure final-state payload builder + bounded-retry sender
  (built-in `fetch`, injected for tests); never throws.
- `src/ops/loadFunc.ts`: pure per-worker load ratio + threshold (concurrency
  cap) and the `ServerOptions.loadFunc` builder.
- `src/ops/readiness.ts`: pure drain-aware readiness state.
- `src/ops/metrics.ts`: the `Metrics` instrument interface, a no-op default,
  and a counting fake for tests.
- `src/ops/telemetry.ts`: the only OpenTelemetry module — builds an OTLP-backed
  `Metrics` (dynamic import, started only when configured) and worker gauges.
- `src/ops/monitoring/handlers.ts`: pure request->`{status, body}` routing for
  the monitoring API; `src/ops/monitoring/server.ts`: thin `node:http` binding.
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

- OpenAI and Google Gemini realtime providers are both enabled by default,
  selected per-job from dispatch metadata through the same local provider
  interface. Gemini is still bounded by `GEMINI_MAX_MINUTES` while long-session
  behavior is verified.
- Job state, interview state, and transcript are persisted to Redis
  (write-through). `REDIS_URL` is required to run the worker.
- Reconnect/reseed is implemented: fatal session failures rebuild a fresh
  session from the durable recap, up to `RECONNECT_MAX_RETRIES`. Proactive
  rotation of a healthy session is deferred (no-op hook in the ContextManager).
- The duration cap (`min(durationMins, 59)`) and the `assertProviderAllowed`
  Gemini gate bound every run.
- Recording to S3 via LiveKit Egress is implemented, gated by
  `enableRecording` with a required-vs-degrade policy from `RECORDING_REQUIRED`.
  One final-state webhook (`job_completed`/`job_failed`) is emitted with a
  bounded retry; in-interview progress events and at-least-once delivery are
  deferred.
- Production ops are implemented: an explicit per-worker concurrency cap
  (`loadFunc` + `loadThreshold`, capped at `MAX_CONCURRENT_INTERVIEWS`), a
  drain-aware readiness flip on SIGTERM with an env-bounded backstop (the
  framework drains active interviews), OpenTelemetry metrics/traces over OTLP,
  and an internal monitoring API (`/healthz`, `/readyz`, `/jobs`, `/jobs/:id`,
  `POST /jobs/:id/cancel`). Cross-process enforcement of a cancel request (the
  child ending its interview) is deferred — cancel records intent only.
- `resolveJobConfig`, the interview state/transcript/reseed models, the
  ContextManager loop, the recording controller, the webhook sender, the load
  function, readiness, and the monitoring handlers are intentionally pure or
  injected-effect so they can be tested without LiveKit, AWS, OTel, or Redis.

## Extension Points

- Wire cancel enforcement (child observes the `cancelled` marker and ends the
  interview) under `src/agent.ts` + the tracker.
- Add provider implementations under `src/providers/` by implementing the local
  provider interface and returning a LiveKit `llm.RealtimeModel`.

See `docs/harness/architecture-invariants.md` for the rules that keep these
boundaries enforceable.
