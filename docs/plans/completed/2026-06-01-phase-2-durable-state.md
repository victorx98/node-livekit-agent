# Phase 2 — Durable State + Transcript (Redis)

Status: completed
Owner: agent
Phase: README status "Phase 2"

## Outcome

Implemented test-first. Verified by unit tests (ioredis-mock) and a real-Redis
integration smoke (`scripts/redis-smoke.mjs`) plus independent `redis-cli`
inspection: state + transcript grow per turn, and keys survive without a TTL when
`finalize` is skipped (the crash path). Full live LiveKit talk-through is the
operator's acceptance step (needs credentials).

## Goal

Persist interview state and transcript write-through to Redis on every turn, and
make the job tracker Redis-backed so job state survives a child-process crash.
No reconnect/reseed logic yet — persistence only (§13–§14, §17).

## Verification (acceptance)

- Run an interview; inspect Redis mid-call and watch `InterviewState` + the
  transcript list grow per turn.
- Kill the child process; confirm state + transcript + job record remain in
  Redis (no `finalize` TTL was applied on crash).

## Module plan (respects architecture invariants)

Layering stays `types -> config -> providers/interview/ops/state -> agent -> main`.

- `src/interview/interviewState.ts` (pure): `InterviewState` model + reducers
  (`createInitialState`, `appendTurn` with a bounded recent-turns ring buffer).
  No Redis, no LiveKit.
- `src/interview/transcriptStore.ts` (pure): `TranscriptEvent` type +
  `chatRoleToTranscriptRole` mapper. No Redis.
- `src/state/redisClient.ts`: lazy ioredis singleton from `REDIS_URL`.
- `src/state/redisStore.ts`: `RedisStore` — the only module that touches Redis.
  Interview-state get/save, transcript append/read (assigns sequence), job
  record CRUD, and `finalize` (sets TTL on completion).
- `src/ops/jobTracker.ts`: add `RedisJobTracker` (delegates to `RedisStore`);
  keep `InMemoryJobTracker`; extract a shared `buildJobRecord` helper.
- `src/agent.ts`: build `RedisStore` + `RedisJobTracker` per job, init state,
  write-through each turn via `conversation_item_added`, serialize writes,
  `finalize` on normal completion. Redis write failures are logged
  (`redis_write_failed`), never silently swallowed, and do not abort the call.

## Test-first cases

- interviewState (pure): initial fields; append increments turns + updates
  lastActivityAt; zero questions → empty unanswered topics; ring buffer caps.
- transcriptStore (pure): role mapping assistant→interviewer, user→candidate,
  system/developer→system.
- redisStore (ioredis-mock): state round-trip; unknown→undefined; transcript
  sequence 1..N in order; job CRUD; finalize sets TTL but keeps data.
- redisJobTracker (ioredis-mock): create/get; merge update; update-unknown
  throws; list; remove; survival via a fresh tracker over the same client.

## Out of scope

Reconnect/reseed (Phase 3), recording, monitoring API, webhooks, telemetry.
