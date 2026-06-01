import { AgentMetadataSchema } from "./schema.js";
import type { ResolvedJobConfig, ModelProvider } from "../types/config.js";

// Adapter from the authoritative wire contract (AgentMetadata) to the internal
// ResolvedJobConfig (§8.2–§8.4). This is the ONLY module that knows the wire
// shape; everything downstream reads ResolvedJobConfig.
//
// Note: the §8.4 design signature takes a LiveKit JobContext. Phase 0 has no
// LiveKit dependency yet, so this core takes the two values a JobContext
// adapter will supply later: the raw metadata string (ctx.job?.metadata) and
// the job id (ctx.job?.id ?? ctx.room.name). Keeping it pure makes the contract
// fast to unit-test and leaves the LiveKit seam intact.

/** Treat unset OR empty-string env vars as "absent" so defaults apply. */
function envStr(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

function normalizeProvider(p: string): ModelProvider {
  const v = p.toLowerCase();
  if (v === "openai") return "openai";
  if (v === "google" || v === "gemini") return "google";
  throw new Error(`Unsupported model_provider: ${p}`);
}

export function resolveJobConfig(rawMetadata: string, jobId: string): ResolvedJobConfig {
  const m = AgentMetadataSchema.parse(JSON.parse(rawMetadata));
  const d = m.interviewData;
  const env = process.env;

  return {
    job_id: jobId,
    interview_id: m.interviewId,
    student_id: m.studentId,
    participant_id: m.participantId,

    model_provider: normalizeProvider(d.model_provider),
    model: d.model_name,
    voice: envStr(env.DEFAULT_VOICE), // not on the wire
    language: d.language,

    interview: {
      title: `${d.position}${d.company ? " @ " + d.company : ""} (${d.interview_type})`,
      role: d.position,
      type: d.interview_type,
      company: d.company,
      duration_minutes: d.durationMins,
      // Prefer the top-level systemInstruction; fall back to the inner one.
      system_prompt: m.systemInstruction || d.systemInstruction,
      questions: d.interview_questions,
      student: d.student,
      participant: d.participant ?? m.participantInfo,
    },

    realtime: {
      turn_detection:
        (envStr(env.TURN_DETECTION) as "semantic_vad" | "server_vad" | undefined) ?? "semantic_vad",
      silence_duration_ms: Number(envStr(env.SILENCE_DURATION_MS) ?? 700),
      interrupt_response: envStr(env.INTERRUPT_RESPONSE) !== "false",
      thinking_level:
        (envStr(env.THINKING_LEVEL) as "minimal" | "low" | "medium" | "high" | undefined) ??
        "minimal",
    },

    recording: {
      enabled: m.options.enableRecording,
      required: env.RECORDING_REQUIRED === "true",
      key: m.recordingKey,
      s3_bucket: envStr(env.RECORDING_S3_BUCKET) ?? "",
      s3_region: envStr(env.AWS_REGION) ?? "",
      audio_only: env.RECORDING_AUDIO_ONLY === "true",
    },

    options: {
      autoStart: m.options.autoStart,
      enableLogging: m.options.enableLogging,
    },
  };
}
