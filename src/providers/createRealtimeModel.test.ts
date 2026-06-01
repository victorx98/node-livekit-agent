import { describe, it, expect, vi } from "vitest";
import { assertProviderAllowed, buildTurnDetection } from "./createRealtimeModel.js";
import { resolveJobConfig } from "../config/resolveConfig.js";
import { sampleAgentMetadata } from "../config/sampleMetadata.js";
import type { AgentMetadata } from "../types/job.js";
import type { ResolvedJobConfig } from "../types/config.js";

function cfgFrom(mutate?: (m: AgentMetadata) => void): ResolvedJobConfig {
  const m = sampleAgentMetadata();
  mutate?.(m);
  return resolveJobConfig(JSON.stringify(m), "job_x");
}

describe("assertProviderAllowed (§11/§15)", () => {
  it("always allows OpenAI regardless of duration", () => {
    expect(() =>
      assertProviderAllowed(
        cfgFrom((m) => {
          m.interviewData.model_provider = "openai";
          m.interviewData.durationMins = 60;
        }),
      ),
    ).not.toThrow();
  });

  it("rejects Gemini when GEMINI_ENABLED is not 'true'", () => {
    vi.stubEnv("GEMINI_ENABLED", "false");
    expect(() =>
      assertProviderAllowed(
        cfgFrom((m) => {
          m.interviewData.model_provider = "google";
          m.interviewData.durationMins = 5;
        }),
      ),
    ).toThrow(/disabled/i);
  });

  it("allows Gemini under the duration cap when enabled", () => {
    vi.stubEnv("GEMINI_ENABLED", "true");
    vi.stubEnv("GEMINI_MAX_MINUTES", "10");
    expect(() =>
      assertProviderAllowed(
        cfgFrom((m) => {
          m.interviewData.model_provider = "google";
          m.interviewData.durationMins = 10;
        }),
      ),
    ).not.toThrow();
  });

  it("rejects Gemini above the duration cap even when enabled", () => {
    vi.stubEnv("GEMINI_ENABLED", "true");
    vi.stubEnv("GEMINI_MAX_MINUTES", "10");
    expect(() =>
      assertProviderAllowed(
        cfgFrom((m) => {
          m.interviewData.model_provider = "google";
          m.interviewData.durationMins = 60;
        }),
      ),
    ).toThrow(/10 min|limited/i);
  });
});

describe("buildTurnDetection (§11)", () => {
  it("defaults to semantic_vad with interruptions on", () => {
    const td = buildTurnDetection({
      turn_detection: "semantic_vad",
      silence_duration_ms: 700,
      interrupt_response: true,
      thinking_level: "minimal",
    });
    expect(td).toMatchObject({
      type: "semantic_vad",
      eagerness: "medium",
      create_response: true,
      interrupt_response: true,
    });
  });

  it("maps server_vad with the configured silence duration", () => {
    const td = buildTurnDetection({
      turn_detection: "server_vad",
      silence_duration_ms: 900,
      interrupt_response: true,
      thinking_level: "minimal",
    });
    expect(td).toMatchObject({
      type: "server_vad",
      silence_duration_ms: 900,
      create_response: true,
      interrupt_response: true,
    });
  });

  it("honors interrupt_response = false", () => {
    const td = buildTurnDetection({
      turn_detection: "semantic_vad",
      silence_duration_ms: 700,
      interrupt_response: false,
      thinking_level: "minimal",
    });
    expect(td.interrupt_response).toBe(false);
  });
});
