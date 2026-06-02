# Phase 4 — Recording + Final Webhook

Status: completed
Owner: agent
Phase: README status "Phase 4"

## Outcome

Implemented test-first. The required-vs-degrade policy (`recorder.ts`), the
filepath resolver (`recordingPlan.ts`), and the webhook builder + bounded-retry
sender (`webhook.ts`) are all unit-tested without LiveKit/AWS (19 new tests, 117
total; `pnpm verify` green). The LiveKit Egress and S3 adapters are thin I/O
modules verified live by the operator. New dependency: `@aws-sdk/client-s3`.
Live acceptance (MP4 in S3 at the recordingKey, webhook delivery, and the
`RECORDING_REQUIRED` behavior) is the operator's step — it needs AWS + LiveKit
credentials and a webhook endpoint.

## Goal

Record the interview to S3 via LiveKit Egress and emit one final-state webhook
(`job_completed` / `job_failed`) at the end (§16, §17):

- S3 preflight (HeadBucket -> PutObject -> Delete) before the interview, then
  start a Room Composite Egress writing an MP4 to the backend-supplied
  `recordingKey`.
- Required-vs-degrade policy from `RECORDING_REQUIRED`: required -> fail the job
  before the interview starts; not required -> log, mark recording `failed`,
  continue.
- Final-state webhook with simple bounded retry/backoff
  (`WEBHOOK_MAX_RETRIES`, `WEBHOOK_RETRY_BASE_MS`). Webhook failure never crashes
  job teardown.

## Design

Keep I/O at the edges and the policy pure/testable (the contextManager pattern):

- `src/recording/recordingPlan.ts` (pure): resolve the Egress filepath from
  `recordingKey` (fallback `interviews/{interview_id}/{job_id}-{time}.{ext}`),
  pick the file extension from `audio_only`.
- `src/recording/recorder.ts`: controller with injected effects (an S3
  `preflight` thunk and an `EgressGateway`). Owns the required-vs-degrade policy
  and safe stop. No LiveKit/AWS imports — unit-tested with fakes.
- `src/recording/egressGateway.ts`: thin LiveKit `EgressClient` adapter
  (builds `EncodedFileOutput` + `S3Upload`, Room Composite). I/O only.
- `src/recording/s3Preflight.ts`: thin `@aws-sdk/client-s3` adapter
  (HeadBucket -> PutObject -> DeleteObject). I/O only.
- `src/ops/webhook.ts`: pure payload builder + bounded-retry sender using the
  built-in `fetch` (injected for tests) and an injected `sleep`. Never throws.
- `src/agent.ts`: start recording after connect (before the interview),
  record `egressId`/`recording` on the job, stop egress on teardown, and emit
  the final webhook from the durable job record.

New dependency: `@aws-sdk/client-s3` (only way to do a live S3 preflight;
isolated behind `s3Preflight.ts`). `fetch` is built into Node 20+ — no webhook
dependency.

## Verification (acceptance)

- Unit: recordingPlan filepath resolution; recorder required-vs-degrade matrix
  (disabled / preflight fail / egress fail x required); safe stop ignores
  already-stopped; webhook builder + retry/backoff/skip-when-unconfigured.
- Live (operator, needs creds): interview produces an MP4 in S3 at the
  `recordingKey`; `job_completed`/`job_failed` reaches the webhook endpoint;
  recording failure behaves per `RECORDING_REQUIRED`.
