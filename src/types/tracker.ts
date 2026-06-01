// Shared job-tracking contracts (§17). Kept in types/ so both the ops tracker
// and the state/redis backend depend on the contract, not on each other.

import type { ModelProvider } from "./config.js";

export type JobStatus =
  | "starting"
  | "connected"
  | "recording"
  | "in_progress"
  | "reconnecting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface JobRecord {
  jobId: string;
  room: string;
  provider: ModelProvider;
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
}
