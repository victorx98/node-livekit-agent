import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { RedisJobTracker } from "./jobTracker.js";
import { RedisStore } from "../state/redisStore.js";

function makeTracker(client: Redis): RedisJobTracker {
  return new RedisJobTracker(new RedisStore(client));
}

describe("RedisJobTracker (§17)", () => {
  let client: Redis;
  let tracker: RedisJobTracker;

  beforeEach(() => {
    client = new RedisMock() as unknown as Redis;
    tracker = makeTracker(client);
  });

  it("creates a record and reads it back", async () => {
    await tracker.create("job_1", { room: "room_a", provider: "openai", status: "starting" });
    expect(await tracker.get("job_1")).toMatchObject({
      jobId: "job_1",
      room: "room_a",
      provider: "openai",
      status: "starting",
    });
  });

  it("merges partial updates and preserves other fields", async () => {
    await tracker.create("job_1", { room: "room_a", provider: "openai", status: "starting" });
    await tracker.update("job_1", { status: "in_progress", turns: 5 });
    const rec = await tracker.get("job_1");
    expect(rec?.status).toBe("in_progress");
    expect(rec?.turns).toBe(5);
    expect(rec?.room).toBe("room_a");
  });

  it("throws when updating an unknown job (fail fast)", async () => {
    await expect(tracker.update("nope", { status: "completed" })).rejects.toThrow(/nope/);
  });

  it("lists and removes job records", async () => {
    await tracker.create("job_1", { room: "a", provider: "openai", status: "starting" });
    await tracker.create("job_2", { room: "b", provider: "openai", status: "connected" });
    expect((await tracker.list()).map((r) => r.jobId).sort()).toEqual(["job_1", "job_2"]);

    await tracker.remove("job_1");
    expect(await tracker.get("job_1")).toBeUndefined();
  });

  it("survives a process restart: a fresh tracker over the same Redis sees the record", async () => {
    await tracker.create("job_1", { room: "room_a", provider: "openai", status: "in_progress" });

    const afterCrash = makeTracker(client);
    const rec = await afterCrash.get("job_1");
    expect(rec?.status).toBe("in_progress");
    expect(rec?.room).toBe("room_a");
  });
});
