import { initializeLogger, llm } from "@livekit/agents";
import { describe, it, expect } from "vitest";
import {
  assertProviderAllowed,
  createRealtimeModel,
  getRealtimeProvider,
  type RealtimeProviderRegistry,
} from "./registry.js";
import { resolveJobConfig } from "../config/resolveConfig.js";
import { sampleAgentMetadata } from "../config/sampleMetadata.js";
import type { AgentMetadata } from "../types/job.js";
import type { Env } from "../config/env.js";
import type { ResolvedJobConfig } from "../types/config.js";

initializeLogger({ pretty: false, level: "silent" });

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
  return resolveJobConfig(JSON.stringify(m), "job_provider_test");
}

function googleOptions(model: llm.RealtimeModel): { contextWindowCompression?: unknown } {
  return (model as unknown as { _options: { contextWindowCompression?: unknown } })._options;
}

describe("realtime provider registry", () => {
  it("constructs an OpenAI realtime model through the shared provider interface", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "openai";
      m.interviewData.model_name = "gpt-realtime";
    });

    assertProviderAllowed({ cfg, env: baseEnv });
    const model = createRealtimeModel({ cfg, env: baseEnv, instructions: "Interview clearly." });

    expect(model).toBeInstanceOf(llm.RealtimeModel);
    expect(model.model).toBe("gpt-realtime");
  });

  it("constructs a Gemini realtime model through the same interface", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "gemini";
      m.interviewData.model_name = "gemini-live-2.5-flash-native-audio";
      m.interviewData.durationMins = 30;
    });

    assertProviderAllowed({ cfg, env: baseEnv });
    const model = createRealtimeModel({ cfg, env: baseEnv, instructions: "Interview clearly." });

    expect(model).toBeInstanceOf(llm.RealtimeModel);
    expect(model.model).toBe("gemini-live-2.5-flash-native-audio");
    expect(googleOptions(model).contextWindowCompression).toEqual({ slidingWindow: {} });
  });

  it("allows Gemini long durations when Google auth is valid", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "google";
      m.interviewData.durationMins = 120;
    });

    expect(() => assertProviderAllowed({ cfg, env: baseEnv })).not.toThrow();
  });

  it("passes a Gemini compression trigger token setting to the LiveKit model", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "google";
    });
    const model = createRealtimeModel({
      cfg,
      env: { ...baseEnv, geminiContextWindowCompressionTriggerTokens: "32000" },
      instructions: "Interview clearly.",
    });

    expect(googleOptions(model).contextWindowCompression).toEqual({
      slidingWindow: {},
      triggerTokens: "32000",
    });
  });

  it("omits Gemini compression config when explicitly disabled", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "google";
    });
    const model = createRealtimeModel({
      cfg,
      env: { ...baseEnv, geminiContextWindowCompressionEnabled: false },
      instructions: "Interview clearly.",
    });

    expect(googleOptions(model).contextWindowCompression).toBeUndefined();
  });

  it("allows the configured Gemini model when duration and auth are valid", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "google";
      m.interviewData.model_name = "gemini-3.1-flash-live-preview";
      m.interviewData.durationMins = 5;
    });

    expect(() => assertProviderAllowed({ cfg, env: baseEnv })).not.toThrow();
  });

  it("rejects OpenAI jobs without OpenAI auth", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "openai";
    });

    expect(() =>
      assertProviderAllowed({ cfg, env: { ...baseEnv, openaiApiKey: undefined } }),
    ).toThrow(/OPENAI_API_KEY/i);
  });

  it("rejects Gemini jobs without Google API key or Vertex auth settings", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "google";
      m.interviewData.durationMins = 5;
    });

    expect(() =>
      assertProviderAllowed({ cfg, env: { ...baseEnv, googleApiKey: undefined } }),
    ).toThrow(/GOOGLE_API_KEY|Vertex/i);
  });

  it("fails clearly when a normalized provider is not registered", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "openai";
    });
    const emptyRegistry: RealtimeProviderRegistry = new Map();

    expect(() => getRealtimeProvider(cfg.model_provider, emptyRegistry)).toThrow(
      /No realtime provider registered for openai/,
    );
  });
});
