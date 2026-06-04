import { AgentMetadataSchema } from "./schema.js";
import type { ResolvedJobConfig, ModelProvider } from "../types/config.js";

export const DEFAULT_OPENAI_MODEL = "gpt-realtime-2";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

// Adapter from the LiveKit dispatch metadata to the internal ResolvedJobConfig
// (§8.2–§8.4). Compatibility normalization lives here so downstream modules only
// consume the strict, canonical shape.

/** Treat unset OR empty-string env vars as "absent" so defaults apply. */
function envStr(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(rawMetadata: unknown): Record<string, unknown> {
  if (typeof rawMetadata === "string") {
    const trimmed = rawMetadata.trim();
    if (!trimmed) throw new Error("Agent metadata is empty.");
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) throw new Error("Agent metadata JSON must be an object.");
    return parsed;
  }

  if (rawMetadata instanceof Uint8Array) {
    return parseMetadata(Buffer.from(rawMetadata).toString("utf8"));
  }

  if (isRecord(rawMetadata)) return rawMetadata;

  throw new Error(`Agent metadata must be an object or JSON string, got ${typeof rawMetadata}.`);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function nullableString(value: unknown): string | null {
  return firstString(value) ?? null;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function booleanish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseInterviewData(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("interviewData JSON must be an object.");
    return parsed;
  }
  return recordOrEmpty(value);
}

function normalizeProvider(p: string): ModelProvider {
  const v = p.toLowerCase();
  if (v === "openai") return "openai";
  if (v === "google" || v === "gemini") return "google";
  throw new Error(`Unsupported model_provider: ${p}`);
}

function defaultModelForProvider(provider: ModelProvider): string {
  if (provider === "openai") return envStr(process.env.OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL;
  return envStr(process.env.GEMINI_MODEL) ?? DEFAULT_GEMINI_MODEL;
}

function normalizeQuestions(rawQuestions: unknown): unknown[] {
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.map((question) =>
    typeof question === "string" ? { question_text: question } : question,
  );
}

function normalizeMetadata(rawMetadata: unknown): Record<string, unknown> {
  const top = parseMetadata(rawMetadata);
  const interviewData = parseInterviewData(top.interviewData ?? top.interview_data);

  const rawProvider =
    firstString(interviewData.model_provider, interviewData.modelProvider, top.provider) ?? "google";
  const modelProvider = normalizeProvider(rawProvider);
  // Gemini: the model id is hardcoded server-side (GEMINI_MODEL env, else
  // DEFAULT_GEMINI_MODEL). We intentionally ignore any model_name in the
  // dispatch metadata because callers send LiveKit-style ids (e.g.
  // "gemini-live-2.5-flash-native-audio") that the Gemini Live bidi API
  // rejects as not-found. OpenAI still honors the metadata model_name.
  const modelName =
    modelProvider === "google"
      ? defaultModelForProvider(modelProvider)
      : firstString(
          interviewData.model_name,
          interviewData.modelName,
          top.model_name,
          top.modelName,
        ) ?? defaultModelForProvider(modelProvider);

  const participantInfoInput = recordOrEmpty(top.participantInfo ?? top.participant_info);
  const participantInput = recordOrEmpty(interviewData.participant);
  const studentInput = recordOrEmpty(interviewData.student);
  const participantName =
    firstString(participantInfoInput.name, participantInput.name, studentInput.name) ?? "Participant";
  const participantEmail = nullableString(
    participantInfoInput.email ?? participantInput.email ?? studentInput.email,
  );
  const participantInfo = { name: participantName, email: participantEmail };
  const studentName = hasOwn(studentInput, "name")
    ? (typeof studentInput.name === "string" ? studentInput.name.trim() : "")
    : participantName;
  const studentEmail = hasOwn(studentInput, "email")
    ? nullableString(studentInput.email)
    : participantEmail;

  const studentId = nullableString(top.studentId ?? top.student_id);
  const participantId = firstString(top.participantId, top.participant_id, studentId) ?? "participant";

  const options = { ...recordOrEmpty(top.options) };
  const topLevelEnableRecording = booleanish(top.enableRecording ?? top.enable_recording);
  if (options.enableRecording === undefined && topLevelEnableRecording !== undefined) {
    options.enableRecording = topLevelEnableRecording;
  }

  return {
    ...top,
    interviewId: firstString(top.interviewId, top.interview_id),
    studentId,
    participantId,
    participantInfo,
    systemInstruction: firstString(top.systemInstruction, top.system_instruction),
    recordingKey: firstString(top.recordingKey, top.recording_key),
    options,
    interviewData: {
      ...interviewData,
      position: firstString(interviewData.position, interviewData.job_title, interviewData.jobTitle),
      interview_type: firstString(interviewData.interview_type, interviewData.interviewType),
      company: firstString(interviewData.company),
      language: firstString(interviewData.language),
      durationMins:
        firstNumber(
          interviewData.durationMins,
          interviewData.duration_mins,
          interviewData.durationMinutes,
          interviewData.duration_minutes,
        ) ?? 30,
      model_provider: modelProvider,
      model_name: modelName,
      interview_questions: normalizeQuestions(
        interviewData.interview_questions ?? interviewData.questions,
      ),
      systemInstruction: firstString(
        interviewData.systemInstruction,
        interviewData.system_instruction,
      ),
      student: {
        ...studentInput,
        objectId: nullableString(studentInput.objectId ?? studentInput.object_id ?? studentId),
        name: studentName,
        email: studentEmail,
      },
      participant: {
        ...participantInput,
        name: firstString(participantInput.name, participantName) ?? participantName,
        email: nullableString(participantInput.email ?? participantEmail),
      },
    },
  };
}

export function resolveJobConfig(rawMetadata: unknown, jobId: string): ResolvedJobConfig {
  const m = AgentMetadataSchema.parse(normalizeMetadata(rawMetadata));
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
      s3_bucket: envStr(env.RECORDING_S3_BUCKET) ?? envStr(env.S3_BUCKET) ?? "",
      s3_region: envStr(env.AWS_REGION) ?? "",
      audio_only: env.RECORDING_AUDIO_ONLY === "true",
    },

    options: {
      autoStart: m.options.autoStart,
      enableLogging: m.options.enableLogging,
    },
  };
}
