import { describe, it, expect } from "vitest";
import { assertProviderAllowed } from "./registry.js";
import { buildOpenAITurnDetection } from "./openai.js";
import { resolveJobConfig } from "../config/resolveConfig.js";
import { sampleAgentMetadata } from "../config/sampleMetadata.js";
import type { AgentMetadata } from "../types/job.js";
import type { ResolvedJobConfig } from "../types/config.js";
import type { Env } from "../config/env.js";

const baseEnv: Env = {
  nodeEnv: "test",
  serviceName: "livekit-ai-interview-agent",
  logLevel: "silent",
  maxConcurrentInterviews: 8,
  numIdleProcesses: 3,
  drainTimeoutSeconds: 3900,
  geminiContextWindowCompressionEnabled: true,
  geminiContextWindowCompressionTriggerTokens: undefined,
  webhookMaxRetries: 3,
  webhookRetryBaseMs: 1000,
  reconnectMaxRetries: 3,
  recordingRequired: false,
  monitoringPort: 8080,
  monitoringHost: "127.0.0.1",
  openaiApiKey: "sk-test",
  googleApiKey: "google-test",
};

function cfgFrom(mutate?: (m: AgentMetadata) => void): ResolvedJobConfig {
  const m = sampleAgentMetadata();
  mutate?.(m);
  return resolveJobConfig(JSON.stringify(m), "job_x");
}

describe("assertProviderAllowed (§11/§15)", () => {
  it("always allows OpenAI regardless of duration", () => {
    expect(() =>
      assertProviderAllowed({
        cfg: cfgFrom((m) => {
          m.interviewData.model_provider = "openai";
          m.interviewData.durationMins = 60;
        }),
        env: baseEnv,
      }),
    ).not.toThrow();
  });

  it("allows Gemini regardless of duration when Google auth is valid", () => {
    expect(() =>
      assertProviderAllowed({
        cfg: cfgFrom((m) => {
          m.interviewData.model_provider = "google";
          m.interviewData.durationMins = 120;
        }),
        env: baseEnv,
      }),
    ).not.toThrow();
  });
});

describe("buildOpenAITurnDetection (§11)", () => {
  it("defaults to semantic_vad with interruptions on", () => {
    const td = buildOpenAITurnDetection({
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
    const td = buildOpenAITurnDetection({
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
    const td = buildOpenAITurnDetection({
      turn_detection: "semantic_vad",
      silence_duration_ms: 700,
      interrupt_response: false,
      thinking_level: "minimal",
    });
    expect(td.interrupt_response).toBe(false);
  });
});
