import { describe, expect, it, vi } from "vitest";
import { buildUsageReceipt, deliverUsage, type RealtimeUsageMetrics } from "./aiUsage.js";

const usage: RealtimeUsageMetrics = {
  requestId: "response-1", timestamp: 1792454400000, durationMs: 1000,
  cancelled: false, inputTokens: 100, outputTokens: 40,
  inputTokenDetails: {
    textTokens: 20, audioTokens: 80, imageTokens: 0, cachedTokens: 30,
    cachedTokensDetails: { textTokens: 10, audioTokens: 20, imageTokens: 0 },
  },
  outputTokenDetails: { textTokens: 10, audioTokens: 30, imageTokens: 0 },
};
const context = {
  jobId: "job-1", interviewId: "interview-1", provider: "openai", model: "gpt-realtime-2",
  environment: "test", billingChannel: "direct", connectionId: "connection-1",
};

describe("realtime AI usage", () => {
  it("keeps cached audio/text separate without double counting", () => {
    const receipt = buildUsageReceipt(usage, context);
    expect(receipt.usage.units).toEqual({
      input_text: 10, input_audio: 60,
      cache_read_text: 10, cache_read_audio: 20,
      output_text: 10, output_audio: 30,
    });
    expect(receipt.callId).toBe("job-1:connection-1:response-1");
    expect(receipt.runId).toBe("interview-1");
  });

  it("retains charges for cancelled responses and does not add reasoning twice", () => {
    const receipt = buildUsageReceipt({ ...usage, cancelled: true, reasoningTokens: 5 }, context);
    expect(receipt.status).toBe("interrupted");
    expect(receipt.usage.outputTokens).toBe(40);
  });

  it("marks cache modality gaps and SDK zero-filled usage as unknown", () => {
    const missing = buildUsageReceipt({
      ...usage, inputTokenDetails: { ...usage.inputTokenDetails, cachedTokensDetails: undefined },
    }, context);
    expect(missing.usage.units.input_unknown).toBeNull();
    const empty = buildUsageReceipt({ ...usage, inputTokens: 0, outputTokens: 0 }, context);
    expect(empty.usage.inputTokens).toBeNull();
  });

  it("retries the same receipt after HTTP failure", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const receipt = buildUsageReceipt(usage, context);
    await expect(deliverUsage(receipt, {
      url: "https://api.example.com/api/internal/ai-usage", token: "test-token",
      fetchFn, sleep: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][1].body).toBe(fetchFn.mock.calls[1][1].body);
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBe("Bearer test-token");
  });

  it("does not throw into interview generation after delivery retries fail", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network"));
    await expect(deliverUsage(buildUsageReceipt(usage, context), {
      url: "https://api.example.com/api/internal/ai-usage", token: "test-token",
      fetchFn, sleep: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
