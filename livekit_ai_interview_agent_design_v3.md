# LiveKit AI Interview Agent Service — Node.js System Design (v3, MVP-first)

> **Revision note (v3).** v2 was production-complete but over-built for a first
> MVP. v3 keeps the design **solid, clean, and simple**: it specifies the
> smallest thing that reliably runs autonomous 1-hour interviews, and pushes
> everything else into a clearly-marked **Deferred (Phase 2+)** section so the
> seams exist without the complexity. Guiding rule: *design the seams now, build
> the minimum now.*
>
> **What changed from v2 (all in response to over-design review):**
> 1. OpenAI session handling is **reconnect/reseed only** in MVP. Proactive
>    rotation is deferred pending a spike (§13, §Deferred).
> 2. **No separate summarizer model** in MVP — deterministic state tracking
>    (question index, asked IDs, recent turns, transcript). Model summary deferred (§13).
> 3. Webhooks: **final `job_completed` / `job_failed` only, simple retry.**
>    At-least-once + idempotency + reconciliation deferred (§17).
> 4. **Redis only** for live state in MVP; transcript artifact to S3. Postgres deferred (§14).
> 5. **OpenAI only** for 1-hour interviews. Gemini behind a feature flag until
>    plugin capability is verified; no custom bridge in MVP (§15).
> 6. Long drain timeout kept for production; **shorter drain in dev/staging** (§19).

---

## 0. MVP scope at a glance

**In scope (Phase 1):**

- Persistent LiveKit agent worker, one child process per interview.
- Job config from LiveKit dispatch metadata (env fallback).
- **OpenAI Realtime** interview, fully autonomous from a single seed, up to 1 hour.
- Deterministic interview state (question index, asked questions, recent turns) + transcript, persisted to **Redis** during the interview.
- **Reconnect + reseed** on provider/connection failure (no proactive rotation).
- Optional S3 recording via LiveKit Egress.
- Monitoring API (health, readiness, job state), structured logs, basic metrics.
- Explicit per-worker concurrency cap; replica sizing method.
- Graceful **draining** shutdown so deploys don't kill live interviews.
- Final-state webhook (`job_completed` / `job_failed`) with simple retry.

**Deferred to Phase 2+ (seams kept, not built):** proactive session rotation, model-based summarizer, Gemini 1-hour support / custom bridge, at-least-once webhook delivery, Postgres audit history, in-interview progress webhooks, post-interview AI evaluation. See **§Deferred**.

---

## 1. Purpose

A Node.js / TypeScript **LiveKit AI Interview Agent Service**: a persistent worker that joins LiveKit rooms as an AI interviewer, conducts real-time spoken interviews, optionally records to S3, and exposes operational monitoring APIs.

External backends dispatch jobs through LiveKit room tokens carrying per-job metadata. The worker reads that metadata, joins the room, runs the interview, manages reliability, records when requested, and reports job state.

The primary operational goal is **fully autonomous interviews**: the agent is seeded once at session start with a system instruction plus an interview goal / question list, then conducts the entire interview — up to one hour — with **no further runtime guidance**. Because of this, **context durability and the ability to reconnect without losing context are first-class MVP requirements.**

---

## 2. Core requirements

### Functional (MVP)

- Run as a persistent LiveKit agent worker.
- Receive jobs through LiveKit dispatch metadata.
- Join each room as an AI agent.
- Conduct a spoken interview using a realtime voice model (OpenAI Realtime: `gpt-realtime-2`).
- Realtime voice interaction: server-side STT/LLM/TTS, server-side VAD, configurable turn detection, user interruptions, thinking level.
- Optionally record to S3 via LiveKit Egress; stop on room end / job end.
- Expose monitoring APIs for health, readiness, job state.
- Metadata is the primary config source; env vars are fallback.
- Run the full interview autonomously from a single seed.
- **Provider abstraction is kept** so Gemini can be added later behind a flag, but only OpenAI is wired for 1-hour interviews in MVP (§15).

### Reliability (MVP)

- Support interviews up to 1 hour.
- Avoid context loss during long interviews.
- Persist transcript + deterministic interview state **during** the interview (Redis), so a reconnect — or a crash-and-retry — can reseed.
- Handle provider/connection failure by **reconnect + reseed** from persisted state.
- Shut down gracefully (drain) without corrupting job state or leaving recordings running, and **without interrupting active interviews on deploy**.

### Operational (MVP)

- Per-worker concurrency cap (load function) + documented replica sizing (§18).
- Structured JSON logs (`pino`).
- Basic OpenTelemetry metrics/traces.
- Final-state webhook with simple retry (§17).
- Clear error reporting.

> **Deferred reliability items** (proactive rotation, model summarizer, Gemini
> 1-hour, durable Postgres history) are in **§Deferred** — the MVP keeps the
> interfaces that let them drop in later.

---

## 3. High-level architecture

```text
External Backend
  └─ creates LiveKit room token + agent dispatch metadata
     └─ candidate joins LiveKit room

LiveKit Cloud / LiveKit Server
  └─ dispatches job to an available worker

Node.js Interview Agent Worker (supervisor process)
  └─ forks ONE CHILD PROCESS per interview job
       ├─ Agent entrypoint
       ├─ Config Resolver
       ├─ Provider Router (OpenAI wired; Gemini behind flag)
       ├─ Interview Orchestrator
       ├─ Context Manager  →  reconnect + reseed (NO rotation in MVP)
       ├─ Interview State (deterministic) + Transcript  →  Redis (write-through)
       ├─ Recording Manager → LiveKit Egress → S3
       ├─ Final webhook emitter (simple retry)
       └─ per-job telemetry / logs

Supervisor also runs:
  ├─ In-memory Job Tracker (mirror of Redis)
  ├─ Monitoring API (Fastify)
  ├─ Load function → concurrency cap
  ├─ Structured Logger
  └─ OpenTelemetry

Shared state (MVP): Redis (live interview state + transcript), S3 (recordings,
optional end-of-interview transcript export).
```

**Concurrency model — read before sizing.** LiveKit Agents runs **each job in
its own child process**, supervised by the worker. So "how many workers" is two
numbers: **jobs per worker process** (a cap you set with a load function) and
**replica count** (`ceil(peak_overlapping_interviews / cap)`). `numIdleProcesses`
is a **prewarm pool size**, not a concurrency cap. See §18.

---

## 4. Technology stack

### Runtime
Node.js 20+, TypeScript, pnpm.

### Core packages (MVP)

```bash
pnpm add @livekit/agents @livekit/rtc-node livekit-server-sdk
pnpm add @livekit/agents-plugin-openai
pnpm add @livekit/agents-plugin-google     # installed, but gated behind a flag (§15)
pnpm add fastify zod pino
pnpm add @aws-sdk/client-s3
pnpm add ioredis                            # live state + transcript
pnpm add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
pnpm add @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http
```

Not in MVP: a summarizer model client, `@google/genai` custom bridge, Postgres
driver. Add when the corresponding deferred feature is built.

> **Build-time verification.** Confirm realtime model identifiers and voice
> names (`gpt-realtime-2`, voice `marin`) against current provider docs at build
> time; realtime model strings change often. For Gemini, see the capability
> gate in §15 before enabling the flag.

### External systems (MVP)
LiveKit (Cloud or self-hosted), OpenAI Realtime API, AWS S3, Redis, an
OTLP-compatible backend (Grafana/Tempo/Prometheus).

---

## 5. Repository layout

```text
src/
  main.ts
  agent.ts

  config/
    schema.ts
    resolveConfig.ts
    env.ts

  providers/
    createRealtimeModel.ts     # OpenAI wired; Gemini path behind flag
    openaiRealtime.ts
    geminiRealtime.ts          # present but flag-gated (§15)
    types.ts

  interview/
    interviewAgent.ts
    buildInstructions.ts
    contextManager.ts          # reconnect + reseed (MVP); rotation hook left as TODO
    interviewState.ts          # deterministic state (no model summary in MVP)
    transcriptStore.ts         # write-through to Redis
    rubric.ts

  state/
    redisStore.ts              # single durable backend in MVP

  recording/
    egressManager.ts
    s3Preflight.ts
    types.ts

  ops/
    jobTracker.ts
    monitoringApi.ts
    loadFunc.ts                # concurrency cap
    webhook.ts                 # final-state, simple retry
    telemetry.ts
    logger.ts
    shutdown.ts

  types/
    job.ts
    config.ts
```

---

## 6. Job dispatch model

External backends create a LiveKit room token with agent dispatch metadata (JSON). The worker parses it from the job context and treats it as the highest-priority config source.

### Dispatch metadata — authoritative contract

The backend dispatches `AgentMetadata` (defined in §8) as the LiveKit job
metadata. The worker parses it, validates it (zod), and maps it to an internal
`ResolvedJobConfig` (§8) that the rest of the service uses. **`AgentMetadata` is
the source of truth; the internal config is a stable adapter so provider/feature
code does not depend on the exact wire shape.**

### Example dispatch metadata

```json
{
  "interviewId": "int_789",
  "interviewData": {
    "objectId": "int_789",
    "student": {
      "objectId": "stu_456",
      "name": "Jordan Lee",
      "email": "jordan@example.com",
      "background": "CS senior, 2 internships",
      "experience_level": "entry"
    },
    "participant": { "name": "Jordan Lee", "email": "jordan@example.com" },
    "interview_type": "technical",
    "language": "en-US",
    "position": "Node.js Backend Engineer",
    "durationMins": 60,
    "model_provider": "openai",
    "model_name": "gpt-realtime-2",
    "interview_questions": [
      {
        "question_text": "Tell me about your backend experience.",
        "purpose_and_focus": "Warm-up; gauge depth.",
        "sub_points": ["scale", "ownership"],
        "category": "background"
      },
      {
        "question_text": "How would you debug a production latency issue?",
        "category": "problem-solving"
      }
    ],
    "company": "MentorX",
    "status": "scheduled",
    "created_at": "2026-06-01T17:50:00.000Z",
    "updated_at": "2026-06-01T17:55:00.000Z",
    "systemInstruction": "You are a professional technical interviewer..."
  },
  "studentId": "stu_456",
  "participantId": "part_001",
  "participantInfo": { "name": "Jordan Lee", "email": "jordan@example.com" },
  "systemInstruction": "You are a professional technical interviewer...",
  "recordingKey": "livekit-interviews/int_789/job_123.mp4",
  "options": {
    "autoStart": true,
    "enableLogging": true,
    "enableRecording": true
  },
  "createdAt": "2026-06-01T17:55:00.000Z"
}
```

### Notes on mapping (full mapping table in §8)

- **No `job_id` on the wire.** Use LiveKit's job/room id from `JobContext` as the
  internal `job_id`; `interviewId` identifies the interview.
- **`durationMins`** (not `duration_minutes`) drives the 1-hour cap and the
  Gemini duration gate (§15).
- **`model_provider` + `model_name`** select the provider/model. `"google"` is
  rejected at runtime for `durationMins > GEMINI_MAX_MINUTES` unless the Gemini
  flag is verified-on (§15).
- **`interview_questions`** are structured objects (`InterviewQuestion`), not
  plain strings — the instruction builder (§12) renders `question_text` plus
  optional `purpose_and_focus` / `sub_points`, and deterministic state (§13)
  tracks them by index.
- **`systemInstruction`** appears both at top level and inside `interviewData`.
  Prefer the top-level one; fall back to `interviewData.systemInstruction`.
- **Recording is driven by `options.enableRecording` + `recordingKey`**, not a
  nested `recording` object. `recordingKey` is the S3 object key/path; bucket and
  region come from env (§7). There is **no per-job `required` flag** on the wire,
  so MVP treats recording as **optional/degrade-on-failure** unless an env
  policy (`RECORDING_REQUIRED`) says otherwise (§16).
- **`options.autoStart`**: if `false`, the agent connects and waits for a start
  signal rather than opening the interview immediately (§9).
- **`options.enableLogging`** toggles verbose per-turn logging for the job.
- **No `webhook_url` on the wire.** The final-state webhook target comes from env
  (`WEBHOOK_URL`) in MVP; per-job callback URLs can be added later (§17).

---

## 7. Config precedence

```text
1. Room token / job metadata
2. LiveKit room metadata
3. Environment variables
4. Safe defaults
```

```ts
function resolveValue<T>(
  metadataValue: T | undefined,
  roomValue: T | undefined,
  envValue: T | undefined,
  defaultValue: T
): T {
  return metadataValue ?? roomValue ?? envValue ?? defaultValue;
}
```

### Environment variables (MVP)

```bash
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

OPENAI_API_KEY=
GOOGLE_API_KEY=                 # only used if Gemini flag is on

AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
RECORDING_S3_BUCKET=
RECORDING_REQUIRED=false        # wire has no per-job 'required'; env policy (§16)

REDIS_URL=                      # live state + transcript

WEBHOOK_URL=                    # final-state webhook target (no URL on the wire, §17)

OTEL_EXPORTER_OTLP_ENDPOINT=
SERVICE_NAME=livekit-ai-interview-agent
NODE_ENV=production

# concurrency + lifecycle
MAX_CONCURRENT_INTERVIEWS=8     # per-worker hard cap (§18)
NUM_IDLE_PROCESSES=3            # prewarm pool, NOT a concurrency cap
DRAIN_TIMEOUT_SECONDS=3900      # prod: > max interview; dev/staging: small (§19)

# provider gating
GEMINI_ENABLED=false            # off until plugin capability verified (§15)
GEMINI_MAX_MINUTES=10           # safe cap while unverified

# webhook (simple retry only in MVP)
WEBHOOK_MAX_RETRIES=3
WEBHOOK_RETRY_BASE_MS=1000
```

---

## 8. Type definitions

### 8.1 Authoritative dispatch contract (from the backend — do not modify)

This is exactly what the LiveKit agent worker receives as job metadata.

```ts
export interface InterviewQuestion {
  question_text: string;
  purpose_and_focus?: string;
  sub_points?: string[];
  category?: string;
}

export interface InterviewStudentInfo {
  objectId?: string | null;
  name: string;
  email: string | null;
  background?: string;
  experience_level?: string;
}

export interface ParticipantInfo {
  name: string;
  email: string | null;
}

export interface AgentInterviewData {
  objectId: string;
  student: InterviewStudentInfo;
  participant: ParticipantInfo;
  interview_type: string;
  language: string;
  position: string;
  durationMins: number;
  model_provider: string;
  model_name: string;
  interview_questions: InterviewQuestion[];
  company: string;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
  systemInstruction: string;
}

export interface AgentMetadata {
  interviewId: string;
  interviewData: AgentInterviewData;
  studentId: string | null;
  participantId: string;
  participantInfo: ParticipantInfo;
  systemInstruction: string;
  recordingKey: string;
  options: {
    autoStart: boolean;
    enableLogging: boolean;
    enableRecording: boolean;
  };
  createdAt: string;
}
```

### 8.2 Internal resolved config (adapter target)

The rest of the service does **not** consume `AgentMetadata` directly. The
config resolver (§8.4) maps it once to `ResolvedJobConfig`, a stable internal
shape. This isolates every provider/feature module from changes to the wire
contract and is the shape referenced throughout §10–§18.

```ts
export type ModelProvider = "openai" | "google";

export interface ResolvedJobConfig {
  // identity
  job_id: string;            // from JobContext (room/job id) — not on the wire
  interview_id: string;      // AgentMetadata.interviewId
  student_id: string | null; // AgentMetadata.studentId
  participant_id: string;    // AgentMetadata.participantId

  // provider selection
  model_provider: ModelProvider; // normalized from interviewData.model_provider
  model: string;                 // interviewData.model_name
  voice?: string;                // env/default; not on the wire
  language: string;              // interviewData.language

  // interview content
  interview: {
    title: string;               // derived: position + interview_type/company
    role: string;                // interviewData.position
    type: string;                // interviewData.interview_type
    company: string;             // interviewData.company
    duration_minutes: number;    // interviewData.durationMins
    system_prompt: string;       // top-level systemInstruction (fallback inner)
    questions: InterviewQuestion[]; // interviewData.interview_questions
    student: InterviewStudentInfo;  // for context/personalization
    participant: ParticipantInfo;
  };

  // realtime tuning — not on the wire; from env/defaults
  realtime: {
    turn_detection: "semantic_vad" | "server_vad";
    silence_duration_ms: number;
    interrupt_response: boolean;
    thinking_level: "minimal" | "low" | "medium" | "high";
  };

  // recording — driven by options.enableRecording + recordingKey
  recording: {
    enabled: boolean;            // options.enableRecording
    required: boolean;           // env RECORDING_REQUIRED (no wire field)
    key: string;                 // recordingKey (S3 object key/path)
    s3_bucket: string;           // env
    s3_region: string;           // env
    audio_only: boolean;         // env/default
  };

  // behavior flags
  options: {
    autoStart: boolean;          // options.autoStart
    enableLogging: boolean;      // options.enableLogging
  };
}
```

### 8.3 Wire → internal mapping

| `ResolvedJobConfig` field | Source in `AgentMetadata` | Notes |
|---|---|---|
| `job_id` | `JobContext` room/job id | **Not on the wire**; assigned by the worker. |
| `interview_id` | `interviewId` | |
| `student_id` | `studentId` | May be null. |
| `participant_id` | `participantId` | |
| `model_provider` | `interviewData.model_provider` | Normalized to `"openai" \| "google"`; unknown → error. |
| `model` | `interviewData.model_name` | |
| `language` | `interviewData.language` | |
| `interview.role` | `interviewData.position` | |
| `interview.type` | `interviewData.interview_type` | |
| `interview.company` | `interviewData.company` | |
| `interview.duration_minutes` | `interviewData.durationMins` | Drives 1-hour cap + Gemini gate. |
| `interview.system_prompt` | `systemInstruction` ?? `interviewData.systemInstruction` | Prefer top-level. |
| `interview.questions` | `interviewData.interview_questions` | Structured `InterviewQuestion[]`. |
| `interview.student` | `interviewData.student` | |
| `interview.participant` | `interviewData.participant` / `participantInfo` | |
| `recording.enabled` | `options.enableRecording` | |
| `recording.key` | `recordingKey` | S3 object key/path. |
| `recording.required` | env `RECORDING_REQUIRED` | **No wire field.** |
| `recording.s3_bucket/region/audio_only` | env / default | **Not on the wire.** |
| `voice` | env / default | **Not on the wire.** |
| `realtime.*` | env / default | **Not on the wire.** |
| `options.autoStart` | `options.autoStart` | |
| `options.enableLogging` | `options.enableLogging` | |
| webhook target | env `WEBHOOK_URL` | **No wire field** (§17). |

### 8.4 Config resolver / adapter

```ts
import { z } from "zod";
import type { JobContext } from "@livekit/agents";
import type { AgentMetadata, ResolvedJobConfig, ModelProvider } from "../types/job";

// Validate the wire contract defensively (shape can drift upstream).
const AgentMetadataSchema = z.object({
  interviewId: z.string(),
  studentId: z.string().nullable(),
  participantId: z.string(),
  systemInstruction: z.string().optional().default(""),
  recordingKey: z.string().optional().default(""),
  options: z.object({
    autoStart: z.boolean().default(true),
    enableLogging: z.boolean().default(true),
    enableRecording: z.boolean().default(false),
  }),
  interviewData: z.object({
    position: z.string(),
    interview_type: z.string().default("general"),
    company: z.string().default(""),
    language: z.string().default("en-US"),
    durationMins: z.number().positive(),
    model_provider: z.string(),
    model_name: z.string(),
    interview_questions: z
      .array(
        z.object({
          question_text: z.string(),
          purpose_and_focus: z.string().optional(),
          sub_points: z.array(z.string()).optional(),
          category: z.string().optional(),
        })
      )
      .default([]),
    systemInstruction: z.string().optional().default(""),
    student: z.object({
      objectId: z.string().nullable().optional(),
      name: z.string(),
      email: z.string().nullable(),
      background: z.string().optional(),
      experience_level: z.string().optional(),
    }),
    participant: z.object({ name: z.string(), email: z.string().nullable() }),
  }),
  participantInfo: z.object({ name: z.string(), email: z.string().nullable() }),
});

function normalizeProvider(p: string): ModelProvider {
  const v = p.toLowerCase();
  if (v === "openai") return "openai";
  if (v === "google" || v === "gemini") return "google";
  throw new Error(`Unsupported model_provider: ${p}`);
}

export function resolveJobConfig(ctx: JobContext): ResolvedJobConfig {
  const raw = JSON.parse(ctx.job?.metadata ?? "{}");
  const m: AgentMetadata = AgentMetadataSchema.parse(raw);
  const d = m.interviewData;

  const env = process.env;
  return {
    job_id: ctx.job?.id ?? ctx.room.name,
    interview_id: m.interviewId,
    student_id: m.studentId,
    participant_id: m.participantId,

    model_provider: normalizeProvider(d.model_provider),
    model: d.model_name,
    voice: env.DEFAULT_VOICE, // not on the wire
    language: d.language,

    interview: {
      title: `${d.position}${d.company ? " @ " + d.company : ""} (${d.interview_type})`,
      role: d.position,
      type: d.interview_type,
      company: d.company,
      duration_minutes: d.durationMins,
      system_prompt: m.systemInstruction || d.systemInstruction,
      questions: d.interview_questions,
      student: d.student,
      participant: d.participant ?? m.participantInfo,
    },

    realtime: {
      turn_detection: (env.TURN_DETECTION as "semantic_vad" | "server_vad") ?? "semantic_vad",
      silence_duration_ms: Number(env.SILENCE_DURATION_MS ?? 700),
      interrupt_response: env.INTERRUPT_RESPONSE !== "false",
      thinking_level: (env.THINKING_LEVEL as "minimal" | "low" | "medium" | "high") ?? "minimal",
    },

    recording: {
      enabled: m.options.enableRecording,
      required: env.RECORDING_REQUIRED === "true",
      key: m.recordingKey,
      s3_bucket: env.RECORDING_S3_BUCKET!,
      s3_region: env.AWS_REGION!,
      audio_only: env.RECORDING_AUDIO_ONLY === "true",
    },

    options: {
      autoStart: m.options.autoStart,
      enableLogging: m.options.enableLogging,
    },
  };
}
```

> Because every downstream module reads `ResolvedJobConfig`, the code in
> §10–§18 (e.g. `cfg.interview.duration_minutes`, `cfg.recording.enabled`,
> `cfg.model_provider`) remains valid unchanged. Only `resolveJobConfig` knows
> the wire shape.

---

## 9. Worker lifecycle (MVP)

```text
1. Supervisor starts: logger, OpenTelemetry, monitoring API, Redis connection,
   load function, LiveKit agent runtime + prewarm pool.
2. LiveKit dispatches a job only if load < threshold.
3. Supervisor forks a child process with the JobContext.
4. Child parses metadata and resolves final config.
5. Child rejects Gemini for long interviews unless verified (§15).
6. Child creates a jobTracker entry AND a Redis interview-state record.
7. Child connects to the LiveKit room.
8. Child optionally starts LiveKit Egress recording.
9. Child creates the OpenAI realtime session. If options.autoStart is true it
   opens the interview immediately; otherwise it connects and waits for a start
   signal (room participant join / control message) before the first turn.
10. Each turn: append to transcript + update deterministic state in Redis.
11. On unexpected drop: reconnect + reseed from Redis state (§13). No rotation.
12. Child handles disconnect / timeout / completion.
13. Child stops recording.
14. Child marks job completed/failed/interrupted (Redis + tracker).
15. Child emits the FINAL webhook (job_completed / job_failed, simple retry).
```

---

## 10. Agent entrypoint (MVP)

> The entrypoint composes a `ContextManager` that does transcript capture +
> reconnect/reseed only. It deliberately does **not** swap the realtime model
> mid-session (proactive rotation is deferred — see §Deferred and the spike note
> in §13).

```ts
import {
  defineAgent,
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  voice,
} from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { resolveJobConfig } from "./config/resolveConfig";
import { assertProviderAllowed } from "./providers/createRealtimeModel";
import { createRealtimeModel } from "./providers/createRealtimeModel";
import { buildInterviewInstructions } from "./interview/buildInstructions";
import { ContextManager } from "./interview/contextManager";
import { jobTracker } from "./ops/jobTracker";
import { redisStore } from "./state/redisStore";
import { maybeStartRecording, stopRecordingSafe } from "./recording/egressManager";
import { emitFinalWebhook } from "./ops/webhook";
import { loadFunc } from "./ops/loadFunc";
import { logger } from "./ops/logger";

export default defineAgent({
  prewarm: async (_proc: JobProcess) => {
    // Keep light. Provider sessions are created per job.
  },

  entry: async (ctx: JobContext) => {
    const cfg = resolveJobConfig(ctx);
    assertProviderAllowed(cfg); // rejects unverified Gemini long interviews (§15)

    const log = logger.child({
      job_id: cfg.job_id,
      interview_id: cfg.interview_id,
      provider: cfg.model_provider,
      room: ctx.room.name,
    });

    await jobTracker.create(cfg.job_id, {
      room: ctx.room.name,
      provider: cfg.model_provider,
      status: "starting",
      startedAt: new Date().toISOString(),
    });

    // Deterministic interview state in Redis; survives a child crash → reseed.
    const state = await redisStore.initInterviewState(cfg);

    let egressId: string | undefined;
    let ctxMgr: ContextManager | undefined;

    try {
      await ctx.connect();
      await jobTracker.update(cfg.job_id, { status: "connected" });

      if (cfg.recording.enabled) {
        egressId = await maybeStartRecording(ctx.room.name, cfg);
        await jobTracker.update(cfg.job_id, { egressId, recording: "active" });
      }

      const instructions = buildInterviewInstructions(cfg);

      // ContextManager (MVP): captures transcript turns + updates deterministic
      // state in Redis, and reconnects + reseeds on an unexpected drop. It does
      // NOT rotate/swap the realtime model mid-interview.
      ctxMgr = new ContextManager({
        cfg,
        instructions,
        state,
        store: redisStore,
        createModel: () =>
          createRealtimeModel({
            provider: cfg.model_provider,
            model: cfg.model,
            voice: cfg.voice,
            instructions,
            realtime: cfg.realtime,
          }),
        log,
      });

      const agent = new voice.Agent({ instructions });
      const session = new voice.AgentSession({ llm: ctxMgr.currentModel() });
      ctxMgr.attach(session, ctx.room);

      await jobTracker.update(cfg.job_id, { status: "in_progress" });
      await session.start({ agent, room: ctx.room });

      await waitForRoomEndOrTimeout(ctx, cfg.interview.duration_minutes);

      await jobTracker.update(cfg.job_id, { status: "completed" });
      await emitFinalWebhook(cfg, { event: "job_completed", job_id: cfg.job_id });
    } catch (err) {
      log.error({ err }, "interview job failed");
      await jobTracker.update(cfg.job_id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      await emitFinalWebhook(cfg, {
        event: "job_failed",
        job_id: cfg.job_id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      await ctxMgr?.dispose();
      if (egressId) await stopRecordingSafe(egressId);
      await jobTracker.update(cfg.job_id, { endedAt: new Date().toISOString() });
      await redisStore.finalize(cfg.job_id);
    }
  },
});

async function waitForRoomEndOrTimeout(
  ctx: JobContext,
  durationMinutes: number
): Promise<void> {
  // Cap below provider hard limits. In MVP this timeout is the only ceiling;
  // there is no proactive rotation.
  const maxMs = Math.min(durationMinutes, 59) * 60_000;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    ctx.room.on("disconnected", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    loadFunc,                 // caps concurrent jobs (§18)
    loadThreshold: 1.0,
    numIdleProcesses: Number(process.env.NUM_IDLE_PROCESSES ?? 3),
  })
);
```

---

## 11. Provider routing (MVP: OpenAI wired, Gemini flag-gated)

```ts
import * as openai from "@livekit/agents-plugin-openai";
import * as google from "@livekit/agents-plugin-google";
import type { ResolvedJobConfig } from "../types/config";

type CreateRealtimeModelArgs = {
  provider: "openai" | "google";
  model?: string;
  voice?: string;
  instructions: string;
  realtime?: {
    turn_detection?: "semantic_vad" | "server_vad";
    silence_duration_ms?: number;
    interrupt_response?: boolean;
    thinking_level?: "minimal" | "low" | "medium" | "high";
  };
};

const GEMINI_ENABLED = process.env.GEMINI_ENABLED === "true";
const GEMINI_MAX_MINUTES = Number(process.env.GEMINI_MAX_MINUTES ?? 10);

// Runtime guard called from the entrypoint.
export function assertProviderAllowed(cfg: ResolvedJobConfig): void {
  if (cfg.model_provider === "google") {
    if (!GEMINI_ENABLED) {
      throw new Error("Gemini is disabled (GEMINI_ENABLED=false). Use OpenAI.");
    }
    if (cfg.interview.duration_minutes > GEMINI_MAX_MINUTES) {
      throw new Error(
        `Gemini limited to ${GEMINI_MAX_MINUTES} min until session resumption ` +
          `+ context compression are verified (§15). Use OpenAI for 1-hour.`
      );
    }
  }
}

export function createRealtimeModel(args: CreateRealtimeModelArgs) {
  if (args.provider === "openai") return createOpenAIRealtimeModel(args);
  return createGeminiRealtimeModel(args); // only reached when allowed (§15)
}

function createOpenAIRealtimeModel(args: CreateRealtimeModelArgs) {
  return new openai.realtime.RealtimeModel({
    model: args.model ?? "gpt-realtime-2",
    voice: args.voice ?? "marin",
    turnDetection:
      args.realtime?.turn_detection === "server_vad"
        ? {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: args.realtime?.silence_duration_ms ?? 700,
            create_response: true,
            interrupt_response: args.realtime?.interrupt_response ?? true,
          }
        : {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: args.realtime?.interrupt_response ?? true,
          },
  });
}

// Present but only used when the flag + duration gate allow it (§15).
function createGeminiRealtimeModel(args: CreateRealtimeModelArgs) {
  return new google.beta.realtime.RealtimeModel({
    model: args.model ?? "gemini-3.1-flash-live-preview",
    voice: args.voice ?? "Puck",
    instructions: args.instructions,
    thinkingConfig: {
      thinkingLevel: args.realtime?.thinking_level ?? "minimal",
      includeThoughts: false,
    },
    // When enabling for long interviews, these must be verified present in the
    // installed JS plugin (§15):
    // contextWindowCompression: { slidingWindow: {} },
    // sessionResumption: { enabled: true },
  });
}
```

---

## 12. Interview instructions

The instruction builder generates one self-sufficient prompt: role, duration, candidate-facing behavior, question strategy, rubric, language/tone, turn-taking, interruptions, completion. Because the agent runs the whole hour from this single seed, it must encode pacing and graceful self-recovery (lean on what it has, never ask an operator).

```ts
export function buildInterviewInstructions(cfg: ResolvedJobConfig): string {
  const questions = cfg.interview.questions.length
    ? cfg.interview.questions
        .map((q, i) => {
          const lines = [`${i + 1}. ${q.question_text}`];
          if (q.purpose_and_focus) lines.push(`   Focus: ${q.purpose_and_focus}`);
          if (q.sub_points?.length)
            lines.push(...q.sub_points.map((s) => `   - ${s}`));
          return lines.join("\n");
        })
        .join("\n")
    : "No fixed questions were provided. Generate relevant questions based on the role.";

  const student = cfg.interview.student;
  const candidateCtx = [
    student.name ? `Candidate: ${student.name}` : "",
    student.experience_level ? `Experience level: ${student.experience_level}` : "",
    student.background ? `Background: ${student.background}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `
You are an AI interviewer conducting a live spoken interview.

Interview:
${cfg.interview.title}

Role:
${cfg.interview.role}${cfg.interview.company ? `\n\nCompany:\n${cfg.interview.company}` : ""}

Target duration:
${cfg.interview.duration_minutes} minutes

Language:
${cfg.language}

${candidateCtx ? `Candidate context:\n${candidateCtx}\n` : ""}
Primary goals:
- Conduct a natural spoken interview.
- Ask one question at a time.
- Listen carefully; ask concise follow-ups when useful.
- Keep moving and pace yourself against the target duration.
- Do not reveal hidden scoring logic.
- Be professional, warm, and neutral.

Turn-taking rules:
- Let the candidate finish before responding.
- If interrupted, stop speaking and listen.
- Prefer short responses; avoid repeating the same question.
- If an answer is vague, ask for a concrete example.

Autonomy and recovery:
- You will receive no further instructions during the interview.
- Track which planned questions you have covered and continue from there.
- If your sense of the conversation feels incomplete, rely on the recap you
  have been given; never announce confusion or ask anyone but the candidate.

Interview plan (each item may include a focus and sub-points to probe):
${questions}

System guidance:
${cfg.interview.system_prompt}

Completion:
- Near the time limit, ask one final wrap-up question, thank the candidate,
  and end politely.
`.trim();
}
```

### Reseed note
On reconnect/reseed, re-supply the full instruction block **plus the recap built
from deterministic state** (question index + asked questions + recent turns) as
the initial content of the new session (§13).

---

## 13. Context and resume strategy (MVP: deterministic state + reconnect/reseed)

Realtime providers keep their own session state, but the worker keeps a
provider-independent local state so a reconnect (or a crash-and-retry) can
rebuild context. **In MVP this state is deterministic — no model-based summary.**

### Interview state model (MVP)

```ts
export type InterviewState = {
  jobId: string;
  interviewId: string;

  currentQuestionIndex: number;
  askedQuestionIds: number[];      // indices already covered
  unansweredTopics: number[];      // planned questions not yet covered

  // Optional, only if cheap to extract deterministically (e.g. keyword tags);
  // NOT a model summary in MVP.
  notes: string[];

  recentTurns: Array<{             // ring buffer, last ~12
    role: "interviewer" | "candidate";
    text: string;
    at: string;
  }>;

  providerResume?: {
    openaiSessionId?: string;
  };

  stats: {
    turns: number;
    reconnects: number;
    startedAt: string;
    lastActivityAt: string;
  };
};
```

### Context policy (MVP)

```text
Every turn:
  - Append the turn to the transcript in Redis (write-through).
  - Push onto recentTurns ring buffer (keep last ~12).
  - Update currentQuestionIndex / askedQuestionIds / unansweredTopics by
    deterministic tracking (e.g. the agent advances when it moves on; or a
    simple matcher against the planned questions).
  - Update turn count + lastActivityAt; persist the state delta to Redis.

On unexpected drop (socket close / provider error):
  - Mark job "reconnecting"; increment reconnects.
  - Open a NEW OpenAI realtime session.
  - Reseed it from Redis state:
      original system instructions
      interview plan
      recap = asked questions + currentQuestionIndex + unansweredTopics
      recentTurns (last 6-12)
  - Verify the conversation can continue; mark "in_progress".
  - If reconnect fails past maxRetry, mark job failed.
```

This is enough to satisfy "don't lose context": the planned-question progress
plus the recent turns let a fresh session pick up coherently. Quality of the
recap improves later with the deferred summarizer — but MVP does not block on it.

### Why Redis write-through is required even in MVP
Interview state lives **outside the child process**, written on every turn. If a
child crashes mid-interview, in-memory state would be gone and resumption
impossible. A retry reloads `InterviewState` by `jobId` from Redis and reseeds.
This directly answers "persist transcript during the interview, not only at the
end" — transcripts are written as turns happen.

> **Deferred — proactive session rotation (needs a spike first).** Swapping the
> realtime model on a live `AgentSession` without breaking audio flow is **not
> yet proven** and must not be assumed as architecture. MVP keeps a single
> session per attempt and relies on reconnect/reseed. The `ContextManager`
> leaves a clearly-marked rotation hook (a no-op in MVP) so rotation can be
> added after a technical spike validates seamless swapping. See §Deferred.

---

## 14. Durable state (MVP: Redis only)

```text
MVP:
  - Redis: live interview state (InterviewState) + transcript, write-through.
  - S3: recordings; optional end-of-interview transcript export as an artifact.

NOT in MVP:
  - Postgres. Add only when you need searchable audit/history/reporting
    (see §Deferred). The jobTracker/transcript interfaces (§17) are written so
    the backend can be swapped without changing call sites.
```

Transcript event shape:

```ts
type TranscriptEvent = {
  jobId: string;
  interviewId: string;
  room: string;
  role: "candidate" | "interviewer" | "system";
  text: string;
  at: string;
  sequence: number;
};
```

---

## 15. OpenAI is the 1-hour provider; Gemini is flag-gated

### OpenAI reliability (MVP)

```text
1. One realtime session per interview attempt.
2. Semantic VAD by default; interruptions on.
3. Write transcript + deterministic state through to Redis.
4. Cap interview at min(duration_minutes, 59) (the timeout ceiling).
5. On failure: reconnect → new session → reseed from Redis state → continue.
   (No proactive rotation in MVP.)
```

### Gemini gate (deferred for 1-hour)

A 1-hour Gemini interview is feasible **only** with two features enabled:

```text
- Audio-only Gemini sessions cap at ~15 min WITHOUT context window compression.
- A single Gemini connection lasts ~10 min (a GoAway precedes the close).
- contextWindowCompression extends sessions effectively unlimited.
- sessionResumption provides handles to reconnect across drops (~2h validity).
```

**MVP policy:** `GEMINI_ENABLED=false`. Even when enabled for testing, Gemini is
capped at `GEMINI_MAX_MINUTES` until both features are **verified present in the
installed `@livekit/agents-plugin-google` (JS)** — confirmed in the Python
plugin, not assumed in JS. Until verified, **OpenAI handles all 1-hour
interviews.**

```text
To graduate Gemini to 1-hour (post-MVP):
  1. Verify the JS plugin exposes contextWindowCompression + sessionResumption.
  2. If present: enable both, store the latest resumption handle, reconnect on
     GoAway using it; flip GEMINI_ENABLED=true and raise GEMINI_MAX_MINUTES.
  3. If absent: patch the plugin OR build a custom @google/genai bridge
     (a Phase 2+ project — NOT an MVP task).
```

This keeps the warning and the seam without paying for a custom bridge now.

---

## 16. Recording design

Metadata-driven via LiveKit Egress.

```text
Before interview:
  1. Check recording.enabled.
  2. Resolve S3 config; run S3 preflight (HeadBucket → PutObject test → Delete).
  3. Start LiveKit Egress; store egress_id in job tracker + Redis.

During interview: keep egress_id attached; monitor disconnects.
After interview:  stop egress explicitly; ignore already-stopped errors.

Failure policy (recording.required from env RECORDING_REQUIRED; no wire field):
  - required = true  → fail the job before the interview starts.
  - required = false → log, mark recording "failed", continue.
```

```ts
import { EgressClient, EncodedFileType, type S3Upload } from "livekit-server-sdk";

const egressClient = new EgressClient(
  process.env.LIVEKIT_URL!,
  process.env.LIVEKIT_API_KEY!,
  process.env.LIVEKIT_API_SECRET!
);

export async function maybeStartRecording(
  roomName: string,
  cfg: ResolvedJobConfig
): Promise<string | undefined> {
  if (!cfg.recording.enabled) return undefined;
  await preflightS3(cfg.recording);

  const s3: S3Upload = {
    accessKey: process.env.AWS_ACCESS_KEY_ID!,
    secret: process.env.AWS_SECRET_ACCESS_KEY!,
    bucket: cfg.recording.s3_bucket ?? process.env.RECORDING_S3_BUCKET!,
    region: cfg.recording.s3_region ?? process.env.AWS_REGION!,
  };
  // The backend supplies the object key directly as recordingKey.
  const filepath = cfg.recording.key || `interviews/${cfg.interview_id}/${cfg.job_id}-{time}.mp4`;

  const result = await egressClient.startRoomCompositeEgress(roomName, {
    file: { fileType: EncodedFileType.MP4, filepath, s3 },
  });
  return result.egressId;
}

export async function stopRecordingSafe(egressId: string): Promise<void> {
  try {
    await egressClient.stopEgress(egressId);
  } catch {
    // May already have stopped when the room ended.
  }
}
```

---

## 17. Job tracker + webhook (MVP)

### Job tracker
In-memory tracker that mirrors Redis (so the supervisor's monitoring API can
report on jobs running in child processes, and a crash doesn't lose job state).

```ts
export type JobStatus =
  | "starting" | "connected" | "recording" | "in_progress"
  | "reconnecting" | "completed" | "failed" | "cancelled" | "interrupted";

export type JobRecord = {
  jobId: string;
  room: string;
  provider: "openai" | "google";
  model?: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  lastActivityAt?: string;
  egressId?: string;
  recording?: "disabled" | "active" | "stopped" | "failed";
  turns?: number;
  reconnects?: number;
  error?: string;
};

interface JobTracker {              // async; write-through to Redis
  create(jobId: string, r: Partial<JobRecord>): Promise<void>;
  update(jobId: string, p: Partial<JobRecord>): Promise<void>;
  get(jobId: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
  remove(jobId: string): Promise<void>;
}
```

### Webhook (final-state only, simple retry)

```text
MVP:
  - Emit ONE webhook at the end: job_completed or job_failed.
  - Simple retry with backoff (WEBHOOK_MAX_RETRIES, WEBHOOK_RETRY_BASE_MS).
  - On final failure: log + metric. No reconciliation marker in MVP.

NOT in MVP (see §Deferred):
  - In-interview progress events.
  - At-least-once delivery, idempotency keys, pending-delivery reconciliation.
    Add these only if the backend depends on webhooks for critical state.
```

---

## 18. Deployment & sizing (MVP)

### Concurrency model
Each interview runs in its **own child process**. "How many workers" = two
numbers:

```text
1. JOBS PER WORKER PROCESS (per-replica cap)
   - Realtime model does STT/LLM/TTS server-side, so per-job CPU is modest,
     but each child process carries fixed MEMORY overhead → usually memory-bound.
   - Cap explicitly with a load function; don't rely on CPU drifting to a limit.

2. REPLICA COUNT
   - replicas = ceil(PEAK_OVERLAPPING_INTERVIEWS / cap) × headroom
   - Use OVERLAPPING interviews (each up to 60 min), not throughput.
```

`numIdleProcesses` is the **prewarm pool size** (instant job acceptance), **not**
a concurrency cap. Prewarm is light here, so 2–4 is plenty.

```ts
// ops/loadFunc.ts — caps concurrent interviews per worker, independent of CPU.
import type { Worker } from "@livekit/agents";
const MAX = Number(process.env.MAX_CONCURRENT_INTERVIEWS ?? 8);
export async function loadFunc(worker: Worker): Promise<number> {
  const active = worker.activeJobs?.length ?? 0;
  return Math.min(active / MAX, 1);   // 1.0 ⇒ worker marked unavailable
}
// On LiveKit Cloud, load_fnc/load_threshold can't be customized; size via
// replica count + agentName dispatch there instead.
```

### Sizing worksheet

```text
P = peak SIMULTANEOUS interviews
C = per-worker cap (MAX_CONCURRENT_INTERVIEWS), chosen from a LOAD TEST
H = headroom (e.g. 1.3 for spikes + rolling deploys)

  1. Pick C empirically: start at 5, run real audio sessions, raise C until
     per-child MEMORY headroom gets tight (voice jobs are memory-bound).
  2. replicas = ceil((P / C) * H)
  3. Size container memory for C child processes + supervisor; CPU for C audio
     pipelines.

Worked example: P=40, C=8, H=1.3 → ceil(6.5) = 7 replicas.
```

### Dockerfile notes
Base on the LiveKit agents-js reference production Dockerfile. Node 20+, pnpm,
build to `dist/`, run `dist/agent.js`. Expose the monitoring API port for K8s
probes. Use exec-form entrypoint so SIGTERM reaches Node (draining, §19).
Provide all env from §7.

---

## 19. Graceful shutdown (drain; short in dev, long in prod)

LiveKit Agents uses a **draining** model: on SIGTERM/SIGINT the worker stops
accepting new jobs but lets active jobs finish, up to `drainTimeout`. A short
grace period would hard-kill live 1-hour interviews on deploy.

```text
On SIGTERM/SIGINT:
1. Flip /readyz to NOT-ready (load balancer drains this replica).
2. Stop accepting new jobs (report unavailable).
3. Let active interviews continue to completion, up to drainTimeout.
4. Only past drainTimeout: mark remaining jobs "interrupted", stop recording,
   disconnect, emit final webhook.
5. Flush Redis writes, logs, OpenTelemetry. Exit.
```

```yaml
# PRODUCTION — let in-flight interviews finish on rollout.
terminationGracePeriodSeconds: 4200   # 70 min
env:
  - name: DRAIN_TIMEOUT_SECONDS
    value: "3900"                      # 65 min, > max interview (59m) + margin
strategy:
  rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }

# DEV / STAGING — fast iteration, interrupting test interviews is fine.
# terminationGracePeriodSeconds: 60
# DRAIN_TIMEOUT_SECONDS: "30"
```

> **Trade-off (decide explicitly):** long prod drain means rollouts take up to
> ~70 min to fully cycle. Given autonomous 1-hour interviews, draining is the
> right call for prod; schedule deploys for low-traffic windows. Dev/staging use
> short drain so iteration stays fast.

---

## 20. Observability

### Logging (`pino`, structured JSON)
Required fields: `service, env, job_id, interview_id, student_id, participant_id,
room, provider, model, event, duration_ms`. Per-turn verbosity is gated by
`options.enableLogging`.

Key events (MVP):
```text
worker_started job_received config_resolved room_connected
recording_started provider_session_started interview_started turn_completed
provider_reconnect_started provider_reconnect_completed
redis_write_failed recording_stopped webhook_sent webhook_failed
job_completed job_failed worker_drain_started worker_shutdown_completed
```

### OpenTelemetry (MVP metrics)
```text
interview_jobs_started_total{provider,model}
interview_jobs_completed_total{provider,model}
interview_jobs_failed_total{provider,model,reason}
interview_active_jobs{provider}
interview_duration_seconds{provider,model}
provider_reconnects_total{provider,model}
worker_concurrent_jobs{worker}
worker_load_ratio{worker}
recording_start_total recording_start_failures_total
redis_write_failures_total webhook_failures_total
```

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

export function startTelemetry() {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
      }),
    }),
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName: process.env.SERVICE_NAME ?? "livekit-ai-interview-agent",
  });
  sdk.start();
  return sdk;
}
```

### Monitoring API (Fastify)
```text
GET  /healthz              liveness
GET  /readyz               readiness; flips NOT-ready on SIGTERM (§19)
GET  /jobs                 active + recent (from Redis-backed tracker)
GET  /jobs/:job_id         one job
POST /jobs/:job_id/cancel  cancel a running job (control plane for cancellation)
GET  /metrics              optional Prometheus endpoint
```
Private by default: bind internal, require service-to-service auth, protect
cancel, don't expose transcripts.

---

## 21. Security

- Never put long-lived secrets in LiveKit tokens. Allowed in metadata: ids,
  provider, model, voice, duration, rubric_id, S3 bucket/prefix, callback URL.
  Never: OpenAI/Google API keys, AWS secrets, DB creds, rubric answer keys.
- Monitoring API internal-only with service auth; cancel endpoint protected.

---

## 22. Build phases

### Phase 1 — MVP (this document)
OpenAI autonomous 1-hour interview · deterministic state + transcript in Redis ·
reconnect/reseed · optional S3 recording · monitoring API · concurrency cap +
sizing · draining shutdown · final-state webhook.

### Phase 2+ — Deferred (see §Deferred)
Proactive rotation (after spike) · model-based summarizer · Gemini 1-hour
(plugin verify or bridge) · at-least-once webhooks · Postgres audit history ·
progress webhooks · post-interview AI evaluation.

---

## 23. Key design decisions

1. **One agent abstraction; OpenAI wired, Gemini behind a flag.** Provider seam
   exists; only OpenAI is paid for at 1 hour now.
2. **Metadata-first config**, env fallback.
3. **Durable Redis state is mandatory even in MVP** — write-through transcript +
   deterministic state so a crash or drop can reseed. No model summary required.
4. **Reconnect/reseed, not rotation, in MVP.** Rotation needs a spike proving
   seamless model swap on a live AgentSession; until then it's a no-op hook.
5. **Recording fails early only when required.**
6. **Concurrency is explicit (load function); prewarm is separate.** Replicas
   derived from peak overlapping interviews.
7. **Deploys drain, they don't kill** — long prod grace; short dev/staging.
8. **Webhook is final-state + simple retry** until the backend needs more.
9. **Monitoring API is operational, not product-facing.**

---

## 24. Open questions — resolved

| # | Question | Resolution |
|---|----------|------------|
| 1 | Recording mandatory or optional? | Per-job `recording.required`; true fails fast, false degrades (§16). |
| 2 | Persist transcript during or at end? | **During**, write-through to Redis (§13). |
| 3 | Live progress webhooks? | **No in MVP** — final-state only, simple retry. Progress + at-least-once deferred (§17, §Deferred). |
| 4 | Concurrent interviews per worker? | Explicit cap via load function, chosen from a load test (memory-bound); replicas = ceil(peak overlapping / cap) × headroom (§18). |
| 5 | AI produces evaluation or only converse? | **Only converse in MVP.** Transcript feeds a separate offline evaluation later (§Deferred). |
| 6 | Gemini for 1-hour before verification? | **No.** OpenAI for 1-hour; Gemini flag-gated + duration-capped until JS plugin capability verified (§15). |
| 7 | Monitoring API expose transcripts? | Off by default; behind auth + flag if needed (§20–21). |
| 8 | Cancellation channel? | Monitoring API `POST /jobs/:id/cancel`; room disconnect also ends the job (§20). |

---

## Deferred (Phase 2+) — seams kept, build later

Each item lists the **trigger** (when it's worth building) and the **seam**
(what in the MVP already accommodates it).

1. **Proactive session rotation (OpenAI).**
   *Trigger:* a spike proves the realtime model can be swapped on a live
   `AgentSession` without breaking audio; and dense hours show context-growth
   degradation. *Seam:* `ContextManager` has a no-op rotation hook and already
   owns session creation, so rotation slots in beside reconnect/reseed.

2. **Model-based summarizer.**
   *Trigger:* deterministic recap proves insufficient for coherent reseeds, or
   product wants richer running notes. *Seam:* `InterviewState.notes` +
   `recentTurns` already exist; add an async, debounced cheap-text-model call
   that fills `notes`/a `compactSummary` field off the critical path. Never
   block a turn on it.

3. **Gemini 1-hour support.**
   *Trigger:* JS plugin verified to expose `contextWindowCompression` +
   `sessionResumption`, OR resourcing for a custom `@google/genai` bridge.
   *Seam:* provider router + `assertProviderAllowed` flag/duration gate already
   present; flip `GEMINI_ENABLED` and raise `GEMINI_MAX_MINUTES` once verified.

4. **At-least-once webhooks + progress events.**
   *Trigger:* backend depends on webhooks for critical state transitions.
   *Seam:* `ops/webhook.ts` is the single emission point; add idempotency keys,
   retries with reconciliation markers, and per-turn/progress events there.

5. **Postgres audit history.**
   *Trigger:* need searchable history / reporting / compliance retention.
   *Seam:* `JobTracker` and transcript store are interfaces over a backend;
   add a Postgres implementation alongside Redis (Redis stays the hot path).

6. **Post-interview AI evaluation.**
   *Trigger:* product wants scoring/feedback. *Seam:* the durable transcript is
   the input; run evaluation as a **separate job**, not inside the realtime
   agent.

---

## Appendix A — v3 changes vs v2 (over-design fixes)

1. OpenAI: **reconnect/reseed only** in MVP; proactive rotation deferred behind a spike (§13, §Deferred #1).
2. **No summarizer model** in MVP; deterministic state (question index, asked IDs, recent turns, transcript) instead (§13, §Deferred #2).
3. Webhook: **final-state + simple retry**; at-least-once/idempotency/progress deferred (§17, §Deferred #4).
4. **Redis only** for live state; S3 for artifacts; Postgres deferred (§14, §Deferred #5).
5. **OpenAI-only for 1-hour**; Gemini flag-gated + duration-capped; no custom bridge in MVP (§15, §Deferred #3).
6. **Drain split by environment**: long in prod, short in dev/staging (§19).
7. Added an explicit **§0 MVP scope** and a **§Deferred** section so the seams are documented without the complexity.
8. **Adopted the backend's authoritative `AgentMetadata` dispatch contract verbatim (§8.1)** and added an internal `ResolvedJobConfig` adapter (§8.2), a wire→internal mapping table (§8.3), and the `resolveJobConfig` resolver (§8.4). Reconciled downstream references: structured `InterviewQuestion[]` rendering in the instruction builder (§12), `durationMins` for the duration cap/gate, `recordingKey` + env `RECORDING_REQUIRED` for recording (§16), env `WEBHOOK_URL` for the final webhook (§17), and `options.autoStart` in the lifecycle (§9). Fields not present on the wire (voice, realtime tuning, S3 bucket/region, recording-required, webhook URL) come from env/defaults.

---

## References
- LiveKit Agents Node.js: https://docs.livekit.io/reference/agents-js/
- LiveKit Worker options (load_fnc, drain, prewarm): https://docs.livekit.io/agents/worker/options/
- LiveKit realtime models: https://docs.livekit.io/agents/models/realtime/
- LiveKit Gemini plugin: https://docs.livekit.io/agents/models/realtime/plugins/gemini/
- LiveKit agent dispatch: https://docs.livekit.io/agents/server/agent-dispatch/
- LiveKit Egress: https://docs.livekit.io/transport/media/ingress-egress/egress/autoegress/
- OpenAI Realtime: https://developers.openai.com/api/docs/guides/realtime-conversations
- Gemini Live session management: https://ai.google.dev/gemini-api/docs/live-session
- OpenTelemetry Node.js: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/
