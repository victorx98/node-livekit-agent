import { describe, it, expect } from "vitest";
import { createNoopMetrics, FakeMetrics } from "./metrics.js";

const labels = { provider: "openai", model: "gpt-realtime" };

describe("createNoopMetrics (§20)", () => {
  it("implements every instrument as a safe no-op", () => {
    const m = createNoopMetrics();
    expect(() => {
      m.jobStarted(labels);
      m.jobCompleted(labels);
      m.jobFailed({ ...labels, reason: "provider_error" });
      m.jobDurationSeconds(123, labels);
      m.providerReconnect(labels);
      m.recordingStarted();
      m.recordingStartFailed();
      m.redisWriteFailed();
      m.webhookFailed();
    }).not.toThrow();
  });
});

describe("FakeMetrics (§20 test double)", () => {
  it("records each instrument call with its labels and values", () => {
    const m = new FakeMetrics();
    m.jobStarted(labels);
    m.jobFailed({ ...labels, reason: "redis_unavailable" });
    m.jobDurationSeconds(42, labels);

    expect(m.calls).toEqual([
      { event: "jobStarted", labels },
      { event: "jobFailed", labels: { ...labels, reason: "redis_unavailable" } },
      { event: "jobDurationSeconds", value: 42, labels },
    ]);
  });

  it("counts repeated instruments", () => {
    const m = new FakeMetrics();
    m.providerReconnect(labels);
    m.providerReconnect(labels);
    m.webhookFailed();
    expect(m.count("providerReconnect")).toBe(2);
    expect(m.count("webhookFailed")).toBe(1);
    expect(m.count("jobCompleted")).toBe(0);
  });
});
