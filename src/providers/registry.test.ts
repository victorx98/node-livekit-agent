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
  recoveryMaxTurns: 24,
  recoveryMaxChars: 24_000,
  forwardAudioIdleTimeoutMs: 300_000,
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

function googleOptions(model: llm.RealtimeModel): {
  contextWindowCompression?: unknown;
  instructions?: string;
  language?: unknown;
  realtimeInputConfig?: {
    automaticActivityDetection?: { silenceDurationMs?: number };
    activityHandling?: string;
  };
} {
  return (
    model as unknown as {
      _options: {
        contextWindowCompression?: unknown;
        instructions?: string;
        language?: unknown;
        realtimeInputConfig?: {
          automaticActivityDetection?: { silenceDurationMs?: number };
          activityHandling?: string;
        };
      };
    }
  )._options;
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

  it("constructs a Gemini realtime model, ignoring the metadata model_name", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "gemini";
      // Dispatchers send LiveKit-style ids the Gemini Live API rejects; the
      // resolver overrides this with the hardcoded server-side default.
      m.interviewData.model_name = "gemini-live-2.5-flash-native-audio";
      m.interviewData.durationMins = 30;
    });

    assertProviderAllowed({ cfg, env: baseEnv });
    const model = createRealtimeModel({ cfg, env: baseEnv, instructions: "Interview clearly." });

    expect(model).toBeInstanceOf(llm.RealtimeModel);
    expect(model.model).toBe("gemini-2.5-flash-native-audio-preview-12-2025");
    expect(googleOptions(model).instructions).toBe("Interview clearly.");
    expect(googleOptions(model).contextWindowCompression).toEqual({ slidingWindow: {} });
    // Language is API-authored interview intelligence and is never separately
    // injected into the provider.
    expect(googleOptions(model).language).toBeUndefined();
    // End-of-speech detection is configured (otherwise Gemini lags by tens of
    // seconds). silenceDurationMs comes from cfg.realtime (default 700).
    expect(
      googleOptions(model).realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs,
    ).toBe(700);
    expect(googleOptions(model).realtimeInputConfig?.activityHandling).toBe(
      "START_OF_ACTIVITY_INTERRUPTS",
    );
  });

  it("does not inject metadata language even for a non-native-audio Gemini model", () => {
    const cfg = cfgFrom((m) => {
      m.interviewData.model_provider = "google";
      m.interviewData.language = "Chinese";
    });
    cfg.model = "gemini-2.0-flash-live-001";

    const model = createRealtimeModel({
      cfg,
      env: baseEnv,
      instructions: "请严格执行 API 指令。",
    });

    expect(googleOptions(model).language).toBeUndefined();
  });

  it("reports model-specific native recovery and greeting capabilities", () => {
    const openaiCfg = cfgFrom((m) => {
      m.interviewData.model_provider = "openai";
    });
    expect(
      getRealtimeProvider(openaiCfg.model_provider).capabilities({
        cfg: openaiCfg,
        env: baseEnv,
      }),
    ).toEqual({
      nativeRecovery: "chat_context_replay",
      supportsProgrammaticGreeting: true,
    });

    const googleCfg = cfgFrom((m) => {
      m.interviewData.model_provider = "google";
    });
    googleCfg.model = "gemini-3.1-flash-live-preview";
    expect(
      getRealtimeProvider(googleCfg.model_provider).capabilities({
        cfg: googleCfg,
        env: baseEnv,
      }),
    ).toEqual({
      nativeRecovery: "session_resumption",
      supportsProgrammaticGreeting: false,
    });
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
