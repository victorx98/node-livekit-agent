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

## Status: Phase 5 — Production ops: concurrency, shutdown, observability

The parent worker now runs safely in production. An explicit **per-worker
concurrency cap** (`loadFunc` + `loadThreshold`) makes a replica report "full"
at `MAX_CONCURRENT_INTERVIEWS` instead of drifting on CPU. On **SIGTERM** the
replica flips `/readyz` to 503 (so the load balancer drains it) while the
framework lets live interviews finish; an env-bounded backstop
(`DRAIN_TIMEOUT_SECONDS`) forces exit only if draining overruns.
**OpenTelemetry** metrics/traces ship over OTLP (started only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set), and a small internal **monitoring API**
(`/healthz`, `/readyz`, `/jobs`, `/jobs/:id`, `POST /jobs/:id/cancel`) runs on
its own port (`MONITORING_PORT`, default 8080; the framework's own health server
is on 8081). A production **K8s manifest** lives in `k8s/`.

**Implemented (Phase 5)**

- Pure concurrency cap — `src/ops/loadFunc.ts`; drain readiness —
  `src/ops/readiness.ts`.
- Metrics interface + no-op + fake — `src/ops/metrics.ts`; OTel adapter (the only
  OTel importer, dynamic + optional) — `src/ops/telemetry.ts`.
- Monitoring API: pure handlers — `src/ops/monitoring/handlers.ts`; thin
  `node:http` server — `src/ops/monitoring/server.ts`.
- `src/main.ts` wires the cap, telemetry, monitoring server, and the SIGTERM
  drain readiness flip + backstop; `src/agent.ts` emits per-job metrics.
- Final `Dockerfile` (exec form, both ports, healthcheck) + `k8s/deployment.yaml`.

> **Cancel is intent-only:** `POST /jobs/:id/cancel` records `status: cancelled`
> on the job and returns 202. Cross-process enforcement (the running child
> observing the marker and ending the interview) is deferred.

**From earlier phases**

- **Phase 4** — recording to S3 via LiveKit Egress (S3 preflight,
  required-vs-degrade per `RECORDING_REQUIRED`) and one final-state webhook
  (`job_completed`/`job_failed`) with bounded retry.
- **Phase 3** — reconnect + reseed via the ContextManager (transient drops
  handled by the selected provider plugin; fatal closes reseeded from the durable Redis
  recap, up to `RECONNECT_MAX_RETRIES`).
- **Phases 0–2** — LiveKit worker + agent, pluggable realtime provider
  registry (OpenAI and gated Google Gemini),
  instruction builder, durable Redis state + transcript + Redis-backed job
  tracker, the `AgentMetadata`→`ResolvedJobConfig` contract, env loading,
  redacting logger. Duration cap (`min(durationMins, 59)`) and the
  `assertProviderAllowed` Gemini gate bound every run.

**Not yet** (later phases): proactive session rotation (no-op hook),
in-interview webhook progress events, cancel enforcement in the child.

> **Model defaults:** per-job metadata should still send `interviewData.model_name`
> when the backend knows the model. If it is omitted, the worker falls back to
> `OPENAI_MODEL=gpt-realtime-2` or
> `GEMINI_MODEL=gemini-3.1-flash-live-preview`.

## Run a live interview (verification)

Prerequisites: a LiveKit project (Cloud or self-hosted), a Redis instance
(`REDIS_URL`, required from Phase 2 on), and credentials for the selected
provider (`OPENAI_API_KEY` for OpenAI, or `GOOGLE_API_KEY`/Vertex settings for
Gemini).

1. `cp .env.example .env` and fill in `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
   `LIVEKIT_API_SECRET`, provider credentials, and `REDIS_URL`.
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

Live: during an interview, force a disconnect. A transient socket drop may be
recovered by the selected provider plugin. A *fatal* failure (plugin retries
exhausted) makes `AgentSession` close with `CloseReason.ERROR`;
the worker logs `provider_reconnect_started` / `provider_reconnect_completed`,
opens a fresh session seeded with the recap, and the agent continues from where
it left off. Tune `RECONNECT_MAX_RETRIES` to bound the attempts.

### Recording + final webhook (Phase 4 acceptance)

The policy and webhook retry are proven by **credential-free unit tests**:

```bash
pnpm test src/recording src/ops/webhook.test.ts
```

Live (needs AWS + LiveKit creds, and a webhook endpoint): set `AWS_REGION`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RECORDING_S3_BUCKET` (or the
Python-era `S3_BUCKET`), and `WEBHOOK_URL` in `.env`, dispatch a job whose
metadata has `options.enableRecording = true` (or top-level `enableRecording =
true`) and a `recordingKey`, then run an interview.

- An **MP4 lands in S3** at the `recordingKey` (the worker logs
  `recording_started` with the egress id and `recording_stopped` at the end).
- Your endpoint receives one **`job_completed`** (or `job_failed`) POST whose
  body is `{ event, job }`.
- Set `RECORDING_REQUIRED=true` and break S3 (e.g. a bad bucket): the job
  **fails before the interview** and you get a `job_failed` webhook. With
  `RECORDING_REQUIRED=false` the same break logs `recording_failed` and the
  interview proceeds without a recording.

### Production ops (Phase 5 acceptance)

The concurrency math, readiness, monitoring routes, and metrics fake are proven
by **credential-free unit/integration tests** (the monitoring server runs over a
real ephemeral port):

```bash
pnpm test src/ops/loadFunc.test.ts src/ops/readiness.test.ts \
          src/ops/metrics.test.ts src/ops/monitoring
```

The monitoring API is live as soon as the worker starts (no LiveKit needed for
the endpoints themselves):

```bash
curl localhost:8080/healthz      # {"status":"ok"}
curl localhost:8080/readyz       # {"status":"ready"} -> 503 {"status":"draining"} after SIGTERM
curl localhost:8080/jobs         # active + recent jobs from the Redis-backed tracker
```

Live (operator):

- **Find the real cap `C`:** raise `MAX_CONCURRENT_INTERVIEWS`, run concurrent
  real audio sessions, and watch per-child memory; the worker reports "full" at
  the cap (load ratio hits 1.0). Size replicas with `ceil((P / C) * H)` (§18).
- **Drain, don't kill:** send `SIGTERM` (or `kubectl rollout restart`) mid-call.
  `/readyz` flips to 503 immediately, the log shows `worker_drain_started`, and
  the **live interview keeps going** until it finishes (bounded by
  `terminationGracePeriodSeconds` / `DRAIN_TIMEOUT_SECONDS`).
- **Metrics in Grafana:** point `OTEL_EXPORTER_OTLP_ENDPOINT` at your collector
  and confirm `interview_jobs_started_total`, `interview_duration_seconds`,
  `worker_load_ratio`, etc. appear. Apply `k8s/deployment.yaml` for the prod
  rollout/drain settings.

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

pnpm dev            # run the worker (dev mode); needs .env with LiveKit + provider creds
pnpm start          # run the worker (production mode)
pnpm dispatch       # create a test dispatch + print a candidate token
```

## Config model

`AgentMetadata` (the canonical wire contract, §8.1) is the preferred metadata
shape. The rest of the service consumes `ResolvedJobConfig` (§8.2).
`resolveJobConfig` is the only module that knows the wire shape — it normalizes
API and deployed Python-agent-compatible payloads, validates with zod, and maps
per the §8.3 table.

In production the LiveKit worker first extracts metadata from the room/job
context in Python-compatible order:

1. `ctx.room.metadata`
2. `ctx.job.accept_arguments.metadata`
3. `ctx.job.acceptArguments.metadata`
4. `ctx.job.job.metadata`
5. `ctx.job.metadata`
6. `ctx.job.request.metadata`

The resolver accepts JSON strings or object payloads. It supports canonical
camelCase keys and legacy snake_case aliases including
`interviewId/interview_id`, `interviewData/interview_data`,
`studentId/student_id`, `participantId/participant_id`, and
`modelName/model_name`.

Python-compatible fallbacks:

- `interviewData` may be a JSON string.
- Provider resolves from `interviewData.model_provider`,
  `interviewData.modelProvider`, top-level `provider`, then `google`.
- Model resolves from metadata first, then `OPENAI_MODEL` or `GEMINI_MODEL`.
- Python-style `job_title` maps to `position`.
- Python-style `questions: string[]` maps to `{ question_text }[]`.
- Top-level `enableRecording` drives recording when
  `options.enableRecording` is absent.
- `RECORDING_S3_BUCKET` falls back to `S3_BUCKET`.

The core resolver remains pure (metadata payload + job id in) so the contract is
fast to unit-test and the LiveKit dependency stays out of the core.

Copy `.env.example` to `.env` and fill in values as subsystems are wired.
