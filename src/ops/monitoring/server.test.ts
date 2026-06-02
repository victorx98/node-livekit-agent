import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startMonitoringServer, type MonitoringServer } from "./server.js";
import { InMemoryJobTracker } from "../jobTracker.js";
import { ReadinessState } from "../readiness.js";

const silentLog = { info() {}, warn() {}, error() {} };

describe("startMonitoringServer (§20 — node:http binding)", () => {
  let server: MonitoringServer;
  let tracker: InMemoryJobTracker;
  let readiness: ReadinessState;
  let base: string;

  beforeEach(async () => {
    tracker = new InMemoryJobTracker();
    readiness = new ReadinessState();
    await tracker.create("job_123", { room: "room_1", provider: "openai", status: "in_progress" });
    // Port 0 -> the OS assigns a free ephemeral port; no fixed-port collisions.
    server = await startMonitoringServer({
      host: "127.0.0.1",
      port: 0,
      deps: { tracker, readiness },
      log: silentLog,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it("serves liveness and the job list over real HTTP", async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const jobs = await fetch(`${base}/jobs`);
    expect(jobs.status).toBe(200);
    expect(await jobs.json()).toEqual({
      jobs: [expect.objectContaining({ jobId: "job_123" })],
    });
  });

  it("flips readiness to 503 once draining", async () => {
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    readiness.beginDraining();
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });

  it("404s an unknown job and 202s a cancel", async () => {
    expect((await fetch(`${base}/jobs/nope`)).status).toBe(404);
    const cancel = await fetch(`${base}/jobs/job_123/cancel`, { method: "POST" });
    expect(cancel.status).toBe(202);
    expect((await tracker.get("job_123"))?.status).toBe("cancelled");
  });

  it("stops answering after close()", async () => {
    await server.close();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    // Re-open for the afterEach close() to remain valid.
    server = await startMonitoringServer({
      host: "127.0.0.1",
      port: 0,
      deps: { tracker, readiness },
      log: silentLog,
    });
  });
});
