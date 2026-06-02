import { describe, it, expect, beforeEach } from "vitest";
import { dispatch, type MonitoringDeps } from "./handlers.js";
import { InMemoryJobTracker } from "../jobTracker.js";
import { ReadinessState } from "../readiness.js";
import type { JobRecord } from "../../types/tracker.js";

function seedJob(tracker: InMemoryJobTracker, overrides: Partial<JobRecord> = {}) {
  return tracker.create("job_123", {
    room: "room_1",
    provider: "openai",
    status: "in_progress",
    ...overrides,
  });
}

describe("monitoring dispatch (§20 monitoring API)", () => {
  let tracker: InMemoryJobTracker;
  let readiness: ReadinessState;
  let deps: MonitoringDeps;

  beforeEach(() => {
    tracker = new InMemoryJobTracker();
    readiness = new ReadinessState();
    deps = { tracker, readiness };
  });

  it("GET /healthz reports liveness", async () => {
    const res = await dispatch({ method: "GET", path: "/healthz" }, deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz is 200 while ready and 503 while draining", async () => {
    expect((await dispatch({ method: "GET", path: "/readyz" }, deps)).status).toBe(200);
    readiness.beginDraining();
    const res = await dispatch({ method: "GET", path: "/readyz" }, deps);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "draining" });
  });

  it("GET /jobs lists tracked jobs", async () => {
    await seedJob(tracker);
    const res = await dispatch({ method: "GET", path: "/jobs" }, deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobs: [expect.objectContaining({ jobId: "job_123" })] });
  });

  it("GET /jobs tolerates a query string", async () => {
    await seedJob(tracker);
    const res = await dispatch({ method: "GET", path: "/jobs?active=true" }, deps);
    expect(res.status).toBe(200);
  });

  it("GET /jobs/:id returns one job, or 404 when unknown", async () => {
    await seedJob(tracker);
    const found = await dispatch({ method: "GET", path: "/jobs/job_123" }, deps);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ jobId: "job_123", status: "in_progress" });

    const missing = await dispatch({ method: "GET", path: "/jobs/nope" }, deps);
    expect(missing.status).toBe(404);
  });

  it("POST /jobs/:id/cancel marks the job cancelled and returns 202", async () => {
    await seedJob(tracker);
    const res = await dispatch({ method: "POST", path: "/jobs/job_123/cancel" }, deps);
    expect(res.status).toBe(202);
    expect((await tracker.get("job_123"))?.status).toBe("cancelled");
  });

  it("POST /jobs/:id/cancel is 404 for an unknown job (no phantom record)", async () => {
    const res = await dispatch({ method: "POST", path: "/jobs/nope/cancel" }, deps);
    expect(res.status).toBe(404);
    expect(await tracker.get("nope")).toBeUndefined();
  });

  it("GET /metrics reports that metrics ship via OTLP push (501, no scrape endpoint)", async () => {
    const res = await dispatch({ method: "GET", path: "/metrics" }, deps);
    expect(res.status).toBe(501);
  });

  it("unknown paths are 404 and unsupported methods are 405", async () => {
    expect((await dispatch({ method: "GET", path: "/nope" }, deps)).status).toBe(404);
    expect((await dispatch({ method: "POST", path: "/healthz" }, deps)).status).toBe(405);
  });
});
