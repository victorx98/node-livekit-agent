// Internal resolved config (§8.2) — the adapter target.
//
// The API owns all interview intelligence. The worker preserves the selected
// system instruction verbatim and only resolves the operational fields needed
// to carry it out over realtime voice.

import type { InterviewQuestion } from "./job.js";

export type ModelProvider = "openai" | "google";

export interface InterviewRecoverySnapshot {
  readonly system_instruction: string;
  readonly questions: readonly Readonly<InterviewQuestion>[];
  readonly language: string;
  readonly interview_type: string;
  readonly position: string;
  readonly company: string;
  readonly duration_minutes: number;
  readonly candidate: Readonly<{
    name: string;
    background?: string;
    experience_level?: string;
  }>;
}

export interface ResolvedJobConfig {
  // identity
  job_id: string; // from JobContext (room/job id) — not on the wire
  interview_id: string; // AgentMetadata.interviewId
  student_id: string | null; // AgentMetadata.studentId
  participant_id: string; // AgentMetadata.participantId

  // provider selection
  model_provider: ModelProvider; // normalized from interviewData.model_provider
  model: string; // interviewData.model_name
  voice?: string; // env/default; not on the wire

  // API-authored interview execution
  system_instruction: string;
  duration_minutes: number;
  greeting_prompt: string;
  recovery_snapshot: InterviewRecoverySnapshot;

  // realtime tuning — not on the wire; from env/defaults
  realtime: {
    turn_detection: "semantic_vad" | "server_vad";
    silence_duration_ms: number;
    interrupt_response: boolean;
    thinking_level: "minimal" | "low" | "medium" | "high";
  };

  // recording — driven by options.enableRecording + recordingKey
  recording: {
    enabled: boolean; // options.enableRecording
    required: boolean; // env RECORDING_REQUIRED (no wire field)
    key: string; // recordingKey (S3 object key/path)
    s3_bucket: string; // env
    s3_region: string; // env
    audio_only: boolean; // env/default
  };

  // behavior flags
  options: {
    autoStart: boolean; // options.autoStart
    enableLogging: boolean; // options.enableLogging
  };
}
