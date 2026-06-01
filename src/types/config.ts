// Internal resolved config (§8.2) — the adapter target.
//
// The rest of the service does NOT consume `AgentMetadata` directly. The config
// resolver (../config/resolveConfig.ts) maps it once to `ResolvedJobConfig`, a
// stable internal shape. This isolates every provider/feature module from
// changes to the wire contract.

import type { InterviewQuestion, InterviewStudentInfo, ParticipantInfo } from "./job.js";

export type ModelProvider = "openai" | "google";

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
  language: string; // interviewData.language

  // interview content
  interview: {
    title: string; // derived: position + interview_type/company
    role: string; // interviewData.position
    type: string; // interviewData.interview_type
    company: string; // interviewData.company
    duration_minutes: number; // interviewData.durationMins
    system_prompt: string; // top-level systemInstruction (fallback inner)
    questions: InterviewQuestion[]; // interviewData.interview_questions
    student: InterviewStudentInfo; // for context/personalization
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
