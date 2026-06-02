# Phase 5 — Production ops: concurrency, shutdown, observability

Status: completed
Owner: agent
Phase: README status "Phase 5"

## Outcome

Implemented test-first. The pure/injected logic is unit-tested without LiveKit,
AWS, OTel, or Redis: `computeLoad`/`loadThresholdFor`, `ReadinessState`, the
`Metrics` no-op + fake, and the monitoring `dispatch`; the monitoring server is
covered by a real ephemeral-port integration test (25 new tests, 142 total;
`pnpm verify` green). `telemetry.ts` (OTel) and the Egress/S3 adapters are thin
I/O verified live. New deps: the `@opentelemetry/*` set (isolated behind the
`Metrics` interface; `node:http` used for the API — no Fastify). Decision points
were confirmed with the user: node:http for the API, full OTel SDK isolated.

Notable finding: `cli.runApp` already drains active jobs on SIGTERM in
production, so Phase 5 adds the readiness flip + env-bounded backstop rather than
re-implementing draining; the framework health server is on 8081, so the
monitoring API uses 8080. Cancel records intent only (deferred enforcement).
Live acceptance (load test for `C`, SIGTERM-drains-not-kills, Grafana metrics) is
the operator's step.

## Goal

Make the worker safe to run in production (§18–§20):

- **Concurrency cap (§18):** an explicit per-worker load function + threshold so a
  replica reports "full" at `MAX_CONCURRENT_INTERVIEWS` instead of drifting on CPU.
- **Draining shutdown (§19):** on SIGTERM the replica stops taking new jobs, lets
  live interviews finish, and only gives up past the drain budget. Env-split:
  long in prod (> max interview), short in dev.
- **Observability (§20):** OpenTelemetry metrics/traces (OTLP) and a small
  internal monitoring API (`/healthz`, `/readyz`, `/jobs`, `/jobs/:id`,
  `/jobs/:id/cancel`, `/metrics`).
- Final Dockerfile + a K8s manifest (prod + dev settings).

## What the framework already does (verified against @livekit/agents@1.4.4)

- `cli.runApp` registers SIGTERM/SIGINT handlers; in production (`start`) it
  `await server.drain()` (waits for active jobs, no fixed timeout) then
  `close()` and exits 143. While draining, new job requests are rejected.
- `ServerOptions` exposes `loadFunc(server) => Promise<number>` and
  `loadThreshold` (worker marked unavailable when load *exceeds* threshold), plus
  `host`/`port`. `server.activeJobs` is `RunningJobInfo[]`.
- The framework runs its own health HTTP server on `port` (default **8081**,
  serving `/` and `/worker`). Our monitoring API therefore uses a **separate**
  port (`MONITORING_PORT`, default 8080).

So Phase 5 adds: the load function + threshold, a readiness flip + env-bounded
drain backstop on SIGTERM, the OTel wiring, the monitoring API, and the
deploy manifests — it does not re-implement draining.

## Design (decisions: node:http for the API; full OTel SDK isolated)

Pure/testable logic, I/O at the edges:

- `src/ops/loadFunc.ts` (pure): `computeLoad(active, max)` and
  `loadThresholdFor(max)` so a replica reports full exactly at `max`; plus
  `makeLoadFunc(max)` returning the `ServerOptions.loadFunc`.
- `src/ops/readiness.ts` (pure): `ReadinessState` — ready until `beginDraining()`.
- `src/ops/metrics.ts` (pure): `Metrics` interface (the §20 instruments), a
  no-op default, and a counting fake for tests.
- `src/ops/telemetry.ts`: thin OTel adapter — starts a NodeSDK (OTLP metric +
  trace exporters, no auto-instrumentation to keep the audio path clean) and
  implements `Metrics`. Built only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set;
  once per process (parent and each job child).
- `src/ops/monitoring/handlers.ts` (pure): request -> `{status, body}` for each
  route, reading the Redis-backed tracker + readiness; never exposes transcripts.
- `src/ops/monitoring/server.ts`: thin `node:http` router/binding (own port).
- `src/main.ts`: wire `loadFunc`/`loadThreshold`/`host`/`port` into
  `ServerOptions`; start telemetry + the monitoring server; on SIGTERM flip
  readiness and arm a `DRAIN_TIMEOUT_SECONDS` backstop.
- `src/agent.ts`: per-job metric calls at started/completed/failed(reason),
  reconnect, recording started/failed, redis-write-failed, webhook-failed.

New deps: `@opentelemetry/sdk-node`, `@opentelemetry/api`,
`@opentelemetry/exporter-metrics-otlp-http`,
`@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-metrics`. The
monitoring API uses the built-in `node:http` (no dependency).

Cancellation (`POST /jobs/:id/cancel`) records intent by setting the job status
to `cancelled` in the tracker and returns 202; cross-process enforcement (the
running child observing the marker and ending the interview) is deferred and
noted here rather than left as a code TODO.

## Verification (acceptance)

- Unit: `computeLoad`/`loadThresholdFor`; `ReadinessState`; monitoring handlers;
  the metrics fake. Integration: the monitoring server over an ephemeral port
  (healthz/readyz/jobs/404/cancel) — all credential-free.
- Live (operator): load-test to find the real per-worker cap `C`; send SIGTERM
  and confirm live interviews finish (not killed) while `/readyz` flips 503;
  confirm metrics appear in Grafana via the OTLP collector.
