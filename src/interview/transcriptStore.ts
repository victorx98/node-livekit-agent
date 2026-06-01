// Transcript event shape (§14) and the role mapping from realtime chat roles to
// transcript speakers. Pure module: persistence is handled by
// src/state/redisStore.ts (write-through to Redis).

export type TranscriptRole = "candidate" | "interviewer" | "system";

export interface TranscriptEvent {
  jobId: string;
  interviewId: string;
  room: string;
  role: TranscriptRole;
  text: string;
  at: string;
  sequence: number;
}

/**
 * Map a realtime ChatMessage role to a transcript speaker. The interviewer is
 * the assistant; the candidate is the user; everything else is system.
 */
export function chatRoleToTranscriptRole(role: string): TranscriptRole {
  if (role === "assistant") return "interviewer";
  if (role === "user") return "candidate";
  return "system";
}
