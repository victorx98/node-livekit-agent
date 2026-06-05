// Authoritative dispatch contract (§8.1) — from the backend, DO NOT MODIFY.
// This is exactly what the LiveKit agent worker receives as job metadata.
// `AgentMetadata` is the source of truth; the internal `ResolvedJobConfig`
// (see ./config.ts) is a stable adapter so feature code never depends on the
// exact wire shape.

export interface InterviewQuestion {
  question_text: string;
  purpose_and_focus?: string;
  sub_points?: string[];
  category?: string;
  [key: string]: unknown;
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
  greetingPrompt?: string;
  recordingKey: string;
  options: {
    autoStart: boolean;
    enableLogging: boolean;
    enableRecording: boolean;
  };
  createdAt: string;
}
