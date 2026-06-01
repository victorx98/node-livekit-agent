# Architecture

This repository implements a Node.js/TypeScript LiveKit AI interview agent.
Phase 1 is a walking skeleton that proves the LiveKit worker, dispatch
metadata, OpenAI realtime model, prompt seed, and job tracking path.

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
  -> in-memory job tracker (`src/ops/jobTracker.ts`)
```

## Modules

- `src/main.ts`: launches the LiveKit Agents CLI parent process.
- `src/agent.ts`: orchestrates one LiveKit job from connect to completion.
- `src/config/env.ts`: reads operational environment values.
- `src/config/schema.ts`: validates dispatch metadata with Zod.
- `src/config/resolveConfig.ts`: adapts wire metadata to `ResolvedJobConfig`.
- `src/config/sampleMetadata.ts`: test and manual-dispatch sample data.
- `src/interview/buildInstructions.ts`: builds the autonomous interview seed.
- `src/providers/createRealtimeModel.ts`: gates providers and creates OpenAI
  realtime models.
- `src/ops/jobTracker.ts`: async job tracking interface and in-memory Phase 1
  implementation.
- `src/ops/logger.ts`: structured Pino logger with secret redaction.
- `src/types/config.ts`: internal resolved configuration contract.
- `src/types/job.ts`: dispatch metadata and job-related wire types.

## Current Constraints

- OpenAI realtime is wired; Gemini remains gated until its long-session behavior
  is verified.
- Job state is in memory for Phase 1; Redis is planned for later hardening.
- Recording, monitoring API, webhooks, telemetry, concurrency caps, and graceful
  draining are deferred.
- `resolveJobConfig` is intentionally pure so the metadata contract can be
  tested without LiveKit runtime dependencies.

## Extension Points

- Add durable state behind the `JobTracker` interface before introducing Redis
  call sites across the codebase.
- Add recording under a dedicated `src/recording/` module so LiveKit egress and
  S3 policy stay separate from `src/agent.ts`.
- Add monitoring and load management under `src/ops/`.
- Add provider implementations under `src/providers/`, keeping duration gates
  and capability checks explicit.

See `docs/harness/architecture-invariants.md` for the rules that keep these
boundaries enforceable.
