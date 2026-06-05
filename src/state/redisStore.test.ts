import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { RedisStore } from "./redisStore.js";
import { createInitialState } from "../interview/interviewState.js";
import type { JobRecord } from "../types/tracker.js";
import type { InterviewRecoverySnapshot } from "../types/config.js";

function makeStore(): { store: RedisStore; client: Redis } {
  const client = new RedisMock() as unknown as Redis;
  return { store: new RedisStore(client), client };
}

const NOW = "2026-06-01T10:00:00.000Z";

function sampleJob(jobId = "job_1"): JobRecord {
  return { jobId, room: "room_a", provider: "openai", status: "starting", startedAt: NOW };
}

function sampleRecoverySnapshot(): InterviewRecoverySnapshot {
  return {
    system_instruction: "API instruction",
    questions: [{ question_text: "Question one" }],
    language: "English",
    interview_type: "technical",
    position: "Engineer",
    company: "MentorX",
    duration_minutes: 30,
    candidate: { name: "Candidate", background: "Backend experience" },
  };
}

describe("RedisStore — interview state (§13)", () => {
  let store: RedisStore;
  beforeEach(() => {
    store = makeStore().store;
  });

  it("round-trips interview state", async () => {
    const state = createInitialState({
      jobId: "job_1",
      interviewId: "int_1",
      now: NOW,
    });
    await store.saveInterviewState(state);
    expect(await store.getInterviewState("job_1")).toEqual(state);
  });

  it("returns undefined for unknown interview state", async () => {
    expect(await store.getInterviewState("missing")).toBeUndefined();
  });
});

describe("RedisStore - recovery snapshot", () => {
  it("round-trips the API-authored recovery snapshot from its dedicated key", async () => {
    const { store } = makeStore();
    const snapshot = sampleRecoverySnapshot();

    await store.saveRecoverySnapshot("job_1", snapshot);

    expect(await store.getRecoverySnapshot("job_1")).toEqual(snapshot);
    expect(await store.getRecoverySnapshot("missing")).toBeUndefined();
  });
});

describe("RedisStore — transcript (§14)", () => {
  let store: RedisStore;
  beforeEach(() => {
    store = makeStore().store;
  });

  it("appends events with monotonic sequence numbers, preserving order", async () => {
    const base = { jobId: "job_1", interviewId: "int_1", room: "room_a", at: NOW };
    const first = await store.appendTranscript({ ...base, role: "interviewer", text: "Hi" });
    const second = await store.appendTranscript({ ...base, role: "candidate", text: "Hello" });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);

    const all = await store.getTranscript("job_1");
    expect(all.map((e) => e.text)).toEqual(["Hi", "Hello"]);
    expect(all.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("returns an empty transcript for an unknown job", async () => {
    expect(await store.getTranscript("missing")).toEqual([]);
  });
});

describe("RedisStore — job records (§17)", () => {
  let store: RedisStore;
  beforeEach(() => {
    store = makeStore().store;
  });

  it("saves, reads, lists, and removes job records", async () => {
    await store.saveJob(sampleJob("job_1"));
    await store.saveJob(sampleJob("job_2"));

    expect(await store.getJob("job_1")).toMatchObject({ jobId: "job_1", room: "room_a" });
    expect((await store.listJobs()).map((j) => j.jobId).sort()).toEqual(["job_1", "job_2"]);

    await store.removeJob("job_1");
    expect(await store.getJob("job_1")).toBeUndefined();
    expect((await store.listJobs()).map((j) => j.jobId)).toEqual(["job_2"]);
  });

  it("returns undefined for an unknown job", async () => {
    expect(await store.getJob("missing")).toBeUndefined();
  });
});

describe("RedisStore — finalize + crash survival", () => {
  it("finalize applies a TTL but keeps the data readable", async () => {
    const { store, client } = makeStore();
    const state = createInitialState({
      jobId: "job_1",
      interviewId: "int_1",
      now: NOW,
    });
    await store.saveInterviewState(state);
    await store.saveRecoverySnapshot("job_1", sampleRecoverySnapshot());
    await store.appendTranscript({
      jobId: "job_1",
      interviewId: "int_1",
      room: "room_a",
      role: "interviewer",
      text: "Hi",
      at: NOW,
    });

    await store.finalize("job_1", 3600);

    expect(await store.getInterviewState("job_1")).toEqual(state);
    expect(await client.ttl("iv:job_1:state")).toBeGreaterThan(0);
    expect(await client.ttl("iv:job_1:recovery")).toBeGreaterThan(0);
    expect(await client.ttl("iv:job_1:transcript")).toBeGreaterThan(0);
  });

  it("state written by one store is visible to another over the same client", async () => {
    const client = new RedisMock() as unknown as Redis;
    const writer = new RedisStore(client);
    const state = createInitialState({
      jobId: "job_1",
      interviewId: "int_1",
      now: NOW,
    });
    await writer.saveInterviewState(state);

    // Simulates a fresh process attaching to the same Redis after a crash.
    const reader = new RedisStore(client);
    expect(await reader.getInterviewState("job_1")).toEqual(state);
  });
});
