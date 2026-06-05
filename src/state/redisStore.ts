import type { Redis } from "ioredis";
import type { InterviewState } from "../interview/interviewState.js";
import type { TranscriptEvent } from "../interview/transcriptStore.js";
import type { InterviewRecoverySnapshot } from "../types/config.js";
import type { JobRecord } from "../types/tracker.js";

// The single durable backend (§14). RedisStore is the ONLY module that issues
// Redis commands; everything else depends on these methods. It is pure
// persistence — no interview/job domain logic beyond serialization and the
// transcript sequence counter.

const DEFAULT_FINALIZE_TTL_SECONDS = 24 * 60 * 60;

const stateKey = (jobId: string): string => `iv:${jobId}:state`;
const recoveryKey = (jobId: string): string => `iv:${jobId}:recovery`;
const transcriptKey = (jobId: string): string => `iv:${jobId}:transcript`;
const jobKey = (jobId: string): string => `job:${jobId}`;
const JOBS_INDEX = "jobs";

export class RedisStore {
  constructor(private readonly redis: Redis) {}

  // --- interview state (write-through) ---

  async saveInterviewState(state: InterviewState): Promise<void> {
    await this.redis.set(stateKey(state.jobId), JSON.stringify(state));
  }

  async getInterviewState(jobId: string): Promise<InterviewState | undefined> {
    const raw = await this.redis.get(stateKey(jobId));
    return raw ? (JSON.parse(raw) as InterviewState) : undefined;
  }

  // --- API-authored recovery snapshot ---

  async saveRecoverySnapshot(jobId: string, snapshot: InterviewRecoverySnapshot): Promise<void> {
    await this.redis.set(recoveryKey(jobId), JSON.stringify(snapshot));
  }

  async getRecoverySnapshot(jobId: string): Promise<InterviewRecoverySnapshot | undefined> {
    const raw = await this.redis.get(recoveryKey(jobId));
    return raw ? (JSON.parse(raw) as InterviewRecoverySnapshot) : undefined;
  }

  // --- transcript (append-only) ---

  /**
   * Append a transcript event, assigning the next sequence number from the
   * current list length. Returns the stored event including its sequence.
   */
  async appendTranscript(event: Omit<TranscriptEvent, "sequence">): Promise<TranscriptEvent> {
    const key = transcriptKey(event.jobId);
    const sequence = (await this.redis.llen(key)) + 1;
    const full: TranscriptEvent = { ...event, sequence };
    await this.redis.rpush(key, JSON.stringify(full));
    return full;
  }

  async getTranscript(jobId: string): Promise<TranscriptEvent[]> {
    const raw = await this.redis.lrange(transcriptKey(jobId), 0, -1);
    return raw.map((entry) => JSON.parse(entry) as TranscriptEvent);
  }

  // --- job records (mirror for the supervisor view) ---

  async saveJob(record: JobRecord): Promise<void> {
    await this.redis.set(jobKey(record.jobId), JSON.stringify(record));
    await this.redis.sadd(JOBS_INDEX, record.jobId);
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
    const raw = await this.redis.get(jobKey(jobId));
    return raw ? (JSON.parse(raw) as JobRecord) : undefined;
  }

  async listJobs(): Promise<JobRecord[]> {
    const ids = await this.redis.smembers(JOBS_INDEX);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map(jobKey));
    return raws.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as JobRecord);
  }

  async removeJob(jobId: string): Promise<void> {
    await this.redis.del(jobKey(jobId));
    await this.redis.srem(JOBS_INDEX, jobId);
  }

  // --- lifecycle ---

  /**
   * Mark an interview finished by expiring its keys after a grace window, so
   * completed interviews stay inspectable but eventually clean up. On a child
   * crash this is never called, so the data persists indefinitely for recovery.
   */
  async finalize(jobId: string, ttlSeconds: number = DEFAULT_FINALIZE_TTL_SECONDS): Promise<void> {
    await Promise.all([
      this.redis.expire(stateKey(jobId), ttlSeconds),
      this.redis.expire(recoveryKey(jobId), ttlSeconds),
      this.redis.expire(transcriptKey(jobId), ttlSeconds),
      this.redis.expire(jobKey(jobId), ttlSeconds),
    ]);
  }
}
