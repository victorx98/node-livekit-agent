# Architecture Invariants

These rules keep the service legible as agents add features.

## Current Layering

```text
types -> config -> providers/interview/recording/ops/state -> agent -> main
```

The arrows show allowed knowledge direction. Lower-level modules should not
import higher-level runtime modules. `providers`, `interview`, `recording`,
`ops`, and `state` are peers; sibling imports are allowed but should stay minimal
(e.g. the Redis-backed job tracker in `ops` delegates persistence to
`state/redisStore`).

## Boundary Rules

- `src/types/` defines shared contracts and must not import application logic.
- `src/config/resolveConfig.ts` is the only module that maps dispatch metadata
  into `ResolvedJobConfig`.
- `src/config/schema.ts` validates the wire contract at the boundary.
- Provider modules consume `ResolvedJobConfig`; they do not parse LiveKit job
  metadata directly.
- The API-authored `systemInstruction` is the only interview prompt. Runtime
  code must not rebuild or augment it from structured interview metadata.
- Interview state/recovery modules are pure: no Redis or room I/O.
  `interview/interviewState.ts`, `interview/transcriptStore.ts`, and
  `interview/reseed.ts` define state and bounded transcript-to-chat restoration.
- `interview/contextManager.ts` is the reconnect/reseed controller. It performs
  no I/O directly — it depends only on injected effects (a session factory, a
  reconnect callback, a logger) so the loop stays unit-testable with fault
  injection. It must not import LiveKit or Redis.
- `src/recording/recorder.ts` is the recording controller and owns the
  required-vs-degrade policy. Like `contextManager`, it performs no I/O directly
  — it depends only on injected effects (an S3 preflight thunk and an
  `EgressGateway`) and must not import LiveKit or the AWS SDK.
  `src/recording/recordingPlan.ts` is pure (filepath/extension resolution).
- `src/recording/egressGateway.ts` is the only module that calls the LiveKit
  Egress API; `src/recording/s3Preflight.ts` is the only module that calls S3.
  These are thin adapters with no policy; they are verified live, not unit-tested.
- `src/ops/webhook.ts` builds the final-state payload (pure) and sends it with a
  bounded retry using injected `fetch`/`sleep`. It must never throw — webhook
  delivery runs during job teardown and cannot be allowed to mask the job result.
- `src/ops/telemetry.ts` is the only module that imports OpenTelemetry. The rest
  of the code depends on the `src/ops/metrics.ts` `Metrics` interface, never on
  OTel directly, so instrumentation is testable with the fake and telemetry stays
  optional (no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset).
- `src/ops/loadFunc.ts` and `src/ops/readiness.ts` are pure. The monitoring API
  keeps routing in the pure `src/ops/monitoring/handlers.ts`; only
  `src/ops/monitoring/server.ts` touches `node:http`. The monitoring API must
  stay private and must never expose transcripts.
- `src/main.ts` owns process lifecycle: the concurrency cap wiring, signal
  handling (drain readiness flip + backstop), telemetry, and the monitoring
  server. Per-job behavior stays in `src/agent.ts` (the child process).
- `src/state/redisStore.ts` is the only module that issues Redis commands.
  `src/state/redisClient.ts` owns the lazy connection. Other modules depend on
  `RedisStore` methods, never on `ioredis` directly.
- `src/agent.ts` owns LiveKit job orchestration and should delegate parsing,
  provider creation, recovery-context construction, state persistence, and job
  tracking to smaller modules.
- `src/main.ts` owns worker process startup and should not contain per-job
  interview behavior.
- Operational modules must keep structured logs and secret redaction intact.

## Dependency Guidance

Prefer dependencies that are easy for future agents to inspect and test. Add a
third-party package only when it removes meaningful complexity and its behavior
is clear from docs or tests.

## When To Promote A Rule

If an architectural rule is violated more than once, promote it from prose into
a mechanical check. Candidate checks include file-size limits, dependency
direction tests, schema naming conventions, and required structured log fields.
