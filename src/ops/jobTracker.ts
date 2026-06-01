import type { JobRecord } from "../types/tracker.js";
import type { RedisStore } from "../state/redisStore.js";

// Job tracker (§17). The interface is async/write-through so an in-memory
// implementation (Phase 1) and a Redis-backed one (Phase 2) are interchangeable
// at call sites. The Redis-backed tracker survives a child-process crash.

export type { JobRecord, JobStatus } from "../types/tracker.js";

export interface JobTracker {
  create(jobId: string, record: Partial<JobRecord>): Promise<void>;
  update(jobId: string, patch: Partial<JobRecord>): Promise<void>;
  get(jobId: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
  remove(jobId: string): Promise<void>;
}

/** Build a full JobRecord from a partial, applying defaults. Shared by both
 * tracker implementations so the default shape stays in one place. */
export function buildJobRecord(jobId: string, record: Partial<JobRecord>): JobRecord {
  return {
    room: record.room ?? "",
    provider: record.provider ?? "openai",
    status: record.status ?? "starting",
    startedAt: record.startedAt ?? new Date().toISOString(),
    ...record,
    // jobId is authoritative; never let the patch override it.
    jobId,
  };
}

export class InMemoryJobTracker implements JobTracker {
  private readonly records = new Map<string, JobRecord>();

  async create(jobId: string, record: Partial<JobRecord>): Promise<void> {
    this.records.set(jobId, buildJobRecord(jobId, record));
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

/** Redis-backed tracker: write-through to the durable store so the supervisor's
 * view (and a crash-and-retry) can recover job state. */
export class RedisJobTracker implements JobTracker {
  constructor(private readonly store: RedisStore) {}

  async create(jobId: string, record: Partial<JobRecord>): Promise<void> {
    await this.store.saveJob(buildJobRecord(jobId, record));
  }

  async update(jobId: string, patch: Partial<JobRecord>): Promise<void> {
    const existing = await this.store.getJob(jobId);
    if (!existing) {
      throw new Error(`Cannot update unknown job: ${jobId}`);
    }
    await this.store.saveJob({ ...existing, ...patch, jobId });
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    return this.store.getJob(jobId);
  }

  async list(): Promise<JobRecord[]> {
    return this.store.listJobs();
  }

  async remove(jobId: string): Promise<void> {
    await this.store.removeJob(jobId);
  }
}
