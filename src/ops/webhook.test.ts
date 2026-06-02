import { describe, it, expect, vi } from "vitest";
import { buildWebhookPayload, sendWebhook } from "./webhook.js";
import type { JobRecord } from "../types/tracker.js";

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: "job_123",
    room: "room_1",
    provider: "openai",
    model: "gpt-realtime",
    status: "completed",
    startedAt: "2026-06-01T10:00:00.000Z",
    endedAt: "2026-06-01T10:30:00.000Z",
    turns: 12,
    reconnects: 1,
    recording: "stopped",
    egressId: "egr_abc",
    ...overrides,
  };
}

function ok(status = 200) {
  return { ok: status >= 200 && status < 300, status } as Response;
}

function deps(over: Partial<Parameters<typeof sendWebhook>[0]> = {}) {
  return {
    url: "https://hooks.example.com/interviews",
    event: "job_completed" as const,
    record: record(),
    maxRetries: 2,
    baseMs: 10,
    fetchFn: vi.fn(async () => ok(200)) as unknown as typeof fetch,
    sleep: vi.fn(async () => {}),
    log: noopLog,
    ...over,
  };
}

describe("buildWebhookPayload (§17)", () => {
  it("tags the payload with the event and carries the job record", () => {
    const payload = buildWebhookPayload("job_failed", record({ status: "failed", error: "boom" }));
    expect(payload.event).toBe("job_failed");
    expect(payload.job.jobId).toBe("job_123");
    expect(payload.job.error).toBe("boom");
  });
});

describe("sendWebhook — final-state delivery with bounded retry (§17)", () => {
  it("skips delivery when no webhook URL is configured", async () => {
    const d = deps({ url: undefined });

    const result = await sendWebhook(d);

    expect(result).toEqual({ delivered: false, skipped: true, attempts: 0 });
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("delivers on the first attempt and POSTs the event as JSON", async () => {
    const d = deps();

    const result = await sendWebhook(d);

    expect(result).toEqual({ delivered: true, attempts: 1 });
    expect(d.sleep).not.toHaveBeenCalled();
    expect(d.fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://hooks.example.com/interviews");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(init.body).event).toBe("job_completed");
  });

  it("retries with exponential backoff after non-2xx responses, then succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok(500))
      .mockResolvedValueOnce(ok(503))
      .mockResolvedValueOnce(ok(200));
    const d = deps({ fetchFn: fetchFn as unknown as typeof fetch });

    const result = await sendWebhook(d);

    expect(result).toEqual({ delivered: true, attempts: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect((d.sleep as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it("retries after a network error then delivers", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(ok(200));
    const d = deps({ fetchFn: fetchFn as unknown as typeof fetch });

    const result = await sendWebhook(d);

    expect(result).toEqual({ delivered: true, attempts: 2 });
    expect(d.sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries without throwing, and logs the failure", async () => {
    const fetchFn = vi.fn(async () => ok(500));
    const d = deps({ fetchFn: fetchFn as unknown as typeof fetch, maxRetries: 2 });

    const result = await sendWebhook(d);

    expect(result).toEqual({ delivered: false, attempts: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(noopLog.error).toHaveBeenCalled();
  });
});
