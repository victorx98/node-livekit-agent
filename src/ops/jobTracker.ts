import type { ModelProvider } from "../types/config.js";

// Job tracker (§17). The interface is async/write-through so a Redis-backed
// implementation can replace this one in a later phase without touching call
// sites. Phase 1 keeps an in-memory implementation only (no Redis).

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

export interface JobTracker {
  create(jobId: string, record: Partial<JobRecord>): Promise<void>;
  update(jobId: string, patch: Partial<JobRecord>): Promise<void>;
  get(jobId: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
  remove(jobId: string): Promise<void>;
}

export class InMemoryJobTracker implements JobTracker {
  private readonly records = new Map<string, JobRecord>();

  async create(jobId: string, record: Partial<JobRecord>): Promise<void> {
    this.records.set(jobId, {
      room: record.room ?? "",
      provider: record.provider ?? "openai",
      status: record.status ?? "starting",
      startedAt: record.startedAt ?? new Date().toISOString(),
      ...record,
      // jobId is authoritative; never let the patch override it.
      jobId,
    });
  }

  async update(jobId: string, patch: Partial<JobRecord>): Promise<void> {
    const existing = this.records.get(jobId);
    if (!existing) {
      // Fail fast: updating a job we never created is a programming error.
      throw new Error(`Cannot update unknown job: ${jobId}`);
    }
    this.records.set(jobId, { ...existing, ...patch, jobId });
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    return this.records.get(jobId);
  }

  async list(): Promise<JobRecord[]> {
    return [...this.records.values()];
  }

  async remove(jobId: string): Promise<void> {
    this.records.delete(jobId);
  }
}

// Single process-wide tracker for the supervisor's view of its jobs.
export const jobTracker: JobTracker = new InMemoryJobTracker();
