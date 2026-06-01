import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryJobTracker } from "./jobTracker.js";

describe("InMemoryJobTracker", () => {
  let tracker: InMemoryJobTracker;

  beforeEach(() => {
    tracker = new InMemoryJobTracker();
  });

  it("creates a record and reads it back", async () => {
    await tracker.create("job_1", { room: "room_a", provider: "openai", status: "starting" });
    const rec = await tracker.get("job_1");
    expect(rec).toMatchObject({
      jobId: "job_1",
      room: "room_a",
      provider: "openai",
      status: "starting",
    });
  });

  it("merges partial updates into an existing record", async () => {
    await tracker.create("job_1", { room: "room_a", provider: "openai", status: "starting" });
    await tracker.update("job_1", { status: "in_progress", turns: 3 });
    const rec = await tracker.get("job_1");
    expect(rec?.status).toBe("in_progress");
    expect(rec?.turns).toBe(3);
    expect(rec?.room).toBe("room_a"); // preserved
  });

  it("returns undefined for an unknown job", async () => {
    expect(await tracker.get("missing")).toBeUndefined();
  });

  it("lists all tracked jobs", async () => {
    await tracker.create("job_1", { room: "a", provider: "openai", status: "starting" });
    await tracker.create("job_2", { room: "b", provider: "openai", status: "connected" });
    const all = await tracker.list();
    expect(all.map((r) => r.jobId).sort()).toEqual(["job_1", "job_2"]);
  });

  it("removes a job", async () => {
    await tracker.create("job_1", { room: "a", provider: "openai", status: "starting" });
    await tracker.remove("job_1");
    expect(await tracker.get("job_1")).toBeUndefined();
  });

  it("updating an unknown job throws (fail fast — no silent create)", async () => {
    await expect(tracker.update("nope", { status: "completed" })).rejects.toThrow(/nope/);
  });
});
