import { describe, it, expect } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("coerces numbers and booleans from string env values", () => {
    const env = loadEnv({
      NODE_ENV: "development",
      SERVICE_NAME: "custom-agent",
      LOG_LEVEL: "debug",
      MAX_CONCURRENT_INTERVIEWS: "12",
      NUM_IDLE_PROCESSES: "4",
      DRAIN_TIMEOUT_SECONDS: "30",
      GEMINI_CONTEXT_WINDOW_COMPRESSION_ENABLED: "false",
      GEMINI_CONTEXT_WINDOW_COMPRESSION_TRIGGER_TOKENS: "32000",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      WEBHOOK_MAX_RETRIES: "5",
      WEBHOOK_RETRY_BASE_MS: "2000",
      RECORDING_REQUIRED: "true",
      RECONNECT_MAX_RETRIES: "4",
      PARTICIPANT_ABSENCE_GRACE_MS: "20000",
      RECOVERY_MAX_TURNS: "30",
      RECOVERY_MAX_CHARS: "30000",
      MONITORING_PORT: "9090",
      MONITORING_HOST: "127.0.0.1",
    });

    expect(env.nodeEnv).toBe("development");
    expect(env.serviceName).toBe("custom-agent");
    expect(env.logLevel).toBe("debug");
    expect(env.maxConcurrentInterviews).toBe(12);
    expect(env.numIdleProcesses).toBe(4);
    expect(env.drainTimeoutSeconds).toBe(30);
    expect(env.geminiContextWindowCompressionEnabled).toBe(false);
    expect(env.geminiContextWindowCompressionTriggerTokens).toBe("32000");
    expect(env.googleGenaiUseVertexai).toBe(true);
    expect(env.webhookMaxRetries).toBe(5);
    expect(env.webhookRetryBaseMs).toBe(2000);
    expect(env.recordingRequired).toBe(true);
    expect(env.reconnectMaxRetries).toBe(4);
    expect(env.participantAbsenceGraceMs).toBe(20000);
    expect(env.recoveryMaxTurns).toBe(30);
    expect(env.recoveryMaxChars).toBe(30000);
    expect(env.monitoringPort).toBe(9090);
    expect(env.monitoringHost).toBe("127.0.0.1");
  });

  it("applies documented defaults (§7) for an empty environment", () => {
    const env = loadEnv({});

    expect(env.nodeEnv).toBe("production");
    expect(env.serviceName).toBe("livekit-ai-interview-agent");
    expect(env.logLevel).toBe("info");
    expect(env.maxConcurrentInterviews).toBe(8);
    expect(env.numIdleProcesses).toBe(3);
    expect(env.drainTimeoutSeconds).toBe(3900);
    expect(env.geminiContextWindowCompressionEnabled).toBe(true);
    expect(env.geminiContextWindowCompressionTriggerTokens).toBeUndefined();
    expect(env.webhookMaxRetries).toBe(3);
    expect(env.webhookRetryBaseMs).toBe(1000);
    expect(env.recordingRequired).toBe(false);
    expect(env.reconnectMaxRetries).toBe(3);
    expect(env.participantAbsenceGraceMs).toBe(15_000);
    expect(env.recoveryMaxTurns).toBe(24);
    expect(env.recoveryMaxChars).toBe(24_000);
    expect(env.monitoringPort).toBe(8080);
    expect(env.monitoringHost).toBe("0.0.0.0");
    expect(env.googleGenaiUseVertexai).toBe(false);
  });

  it("exposes optional connection settings as undefined when unset", () => {
    const env = loadEnv({});
    expect(env.livekitUrl).toBeUndefined();
    expect(env.openaiApiKey).toBeUndefined();
    expect(env.openaiRealtimeVoice).toBeUndefined();
    expect(env.googleApiKey).toBeUndefined();
    expect(env.googleRealtimeVoice).toBeUndefined();
    expect(env.googleCloudProject).toBeUndefined();
    expect(env.googleCloudLocation).toBeUndefined();
    expect(env.redisUrl).toBeUndefined();
    expect(env.webhookUrl).toBeUndefined();
  });

  it("passes through optional connection settings when present", () => {
    const env = loadEnv({
      LIVEKIT_URL: "wss://example.livekit.cloud",
      OPENAI_API_KEY: "sk-test",
      OPENAI_REALTIME_VOICE: "marin",
      GOOGLE_API_KEY: "google-test",
      GOOGLE_REALTIME_VOICE: "Puck",
      GOOGLE_CLOUD_PROJECT: "project-123",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      REDIS_URL: "redis://localhost:6379",
      WEBHOOK_URL: "https://backend/webhook",
    });
    expect(env.livekitUrl).toBe("wss://example.livekit.cloud");
    expect(env.openaiApiKey).toBe("sk-test");
    expect(env.openaiRealtimeVoice).toBe("marin");
    expect(env.googleApiKey).toBe("google-test");
    expect(env.googleRealtimeVoice).toBe("Puck");
    expect(env.googleCloudProject).toBe("project-123");
    expect(env.googleCloudLocation).toBe("us-central1");
    expect(env.redisUrl).toBe("redis://localhost:6379");
    expect(env.webhookUrl).toBe("https://backend/webhook");
  });

  it("throws a descriptive error for a non-numeric integer setting", () => {
    expect(() => loadEnv({ MAX_CONCURRENT_INTERVIEWS: "lots" })).toThrow(
      /MAX_CONCURRENT_INTERVIEWS/,
    );
  });

  it("throws a descriptive error for an invalid Gemini compression trigger", () => {
    expect(() => loadEnv({ GEMINI_CONTEXT_WINDOW_COMPRESSION_TRIGGER_TOKENS: "0" })).toThrow(
      /GEMINI_CONTEXT_WINDOW_COMPRESSION_TRIGGER_TOKENS/,
    );
  });

  it("rejects non-positive recovery context limits", () => {
    expect(() => loadEnv({ RECOVERY_MAX_TURNS: "0" })).toThrow(/RECOVERY_MAX_TURNS/);
    expect(() => loadEnv({ RECOVERY_MAX_CHARS: "-1" })).toThrow(/RECOVERY_MAX_CHARS/);
  });

  it("rejects non-positive participant absence grace values", () => {
    expect(() => loadEnv({ PARTICIPANT_ABSENCE_GRACE_MS: "0" })).toThrow(
      /PARTICIPANT_ABSENCE_GRACE_MS/,
    );
    expect(() => loadEnv({ PARTICIPANT_ABSENCE_GRACE_MS: "-1" })).toThrow(
      /PARTICIPANT_ABSENCE_GRACE_MS/,
    );
  });
});
