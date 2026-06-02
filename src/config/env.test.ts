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
      GEMINI_ENABLED: "true",
      GEMINI_MAX_MINUTES: "15",
      WEBHOOK_MAX_RETRIES: "5",
      WEBHOOK_RETRY_BASE_MS: "2000",
      RECORDING_REQUIRED: "true",
      RECONNECT_MAX_RETRIES: "4",
      MONITORING_PORT: "9090",
      MONITORING_HOST: "127.0.0.1",
    });

    expect(env.nodeEnv).toBe("development");
    expect(env.serviceName).toBe("custom-agent");
    expect(env.logLevel).toBe("debug");
    expect(env.maxConcurrentInterviews).toBe(12);
    expect(env.numIdleProcesses).toBe(4);
    expect(env.drainTimeoutSeconds).toBe(30);
    expect(env.geminiEnabled).toBe(true);
    expect(env.geminiMaxMinutes).toBe(15);
    expect(env.webhookMaxRetries).toBe(5);
    expect(env.webhookRetryBaseMs).toBe(2000);
    expect(env.recordingRequired).toBe(true);
    expect(env.reconnectMaxRetries).toBe(4);
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
    expect(env.geminiEnabled).toBe(false);
    expect(env.geminiMaxMinutes).toBe(10);
    expect(env.webhookMaxRetries).toBe(3);
    expect(env.webhookRetryBaseMs).toBe(1000);
    expect(env.recordingRequired).toBe(false);
    expect(env.reconnectMaxRetries).toBe(3);
    expect(env.monitoringPort).toBe(8080);
    expect(env.monitoringHost).toBe("0.0.0.0");
  });

  it("exposes optional connection settings as undefined when unset", () => {
    const env = loadEnv({});
    expect(env.livekitUrl).toBeUndefined();
    expect(env.openaiApiKey).toBeUndefined();
    expect(env.redisUrl).toBeUndefined();
    expect(env.webhookUrl).toBeUndefined();
  });

  it("passes through optional connection settings when present", () => {
    const env = loadEnv({
      LIVEKIT_URL: "wss://example.livekit.cloud",
      OPENAI_API_KEY: "sk-test",
      REDIS_URL: "redis://localhost:6379",
      WEBHOOK_URL: "https://backend/webhook",
    });
    expect(env.livekitUrl).toBe("wss://example.livekit.cloud");
    expect(env.openaiApiKey).toBe("sk-test");
    expect(env.redisUrl).toBe("redis://localhost:6379");
    expect(env.webhookUrl).toBe("https://backend/webhook");
  });

  it("throws a descriptive error for a non-numeric integer setting", () => {
    expect(() => loadEnv({ MAX_CONCURRENT_INTERVIEWS: "lots" })).toThrow(
      /MAX_CONCURRENT_INTERVIEWS/,
    );
  });
});
