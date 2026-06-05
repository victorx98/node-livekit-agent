// Operational environment loading (§7). This covers worker-level settings
// (concurrency, lifecycle, observability, provider gating) — distinct from
// per-job config, which comes from dispatch metadata via resolveJobConfig.
//
// Per-job realtime/recording env (DEFAULT_VOICE, TURN_DETECTION, ...) is read
// inside resolveJobConfig, since it is resolved against each job's metadata.
//
// In Phase 0 the worker connects to nothing, so connection secrets are optional
// here; they become required when their subsystem is wired in later phases.
//
// .env files: load with Node's built-in flag at startup, e.g.
//   node --env-file=.env dist/main.js
// so no dotenv dependency is needed.

export type EnvSource = Record<string, string | undefined>;

export interface Env {
  nodeEnv: string;
  serviceName: string;
  logLevel: string;

  // concurrency + lifecycle (§18, §19)
  maxConcurrentInterviews: number;
  numIdleProcesses: number;
  drainTimeoutSeconds: number;

  // Gemini live long-session behavior (§15)
  geminiContextWindowCompressionEnabled: boolean;
  geminiContextWindowCompressionTriggerTokens?: string;

  // webhook (§17)
  webhookMaxRetries: number;
  webhookRetryBaseMs: number;

  // reconnect/reseed (§13)
  reconnectMaxRetries: number;
  recoveryMaxTurns: number;
  recoveryMaxChars: number;

  // Realtime audio: how long the framework waits for the model's first audio
  // frame before giving up on a response. The default (10s) is tuned for TTS;
  // realtime models only emit audio after the user's turn ends, so a long
  // answer (> this) gets its response dropped. Raise it past the longest
  // expected single user turn.
  forwardAudioIdleTimeoutMs: number;

  // recording policy (§16)
  recordingRequired: boolean;

  // monitoring API (§20); separate port from the framework health server (8081)
  monitoringPort: number;
  monitoringHost: string;

  // optional connection settings (wired in later phases)
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  openaiApiKey?: string;
  openaiRealtimeVoice?: string;
  googleApiKey?: string;
  googleRealtimeVoice?: string;
  googleGenaiUseVertexai?: boolean;
  googleCloudProject?: string;
  googleCloudLocation?: string;
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  recordingS3Bucket?: string;
  redisUrl?: string;
  webhookUrl?: string;
  otelExporterOtlpEndpoint?: string;
}

function str(source: EnvSource, name: string): string | undefined {
  const v = source[name];
  return v && v.trim() !== "" ? v : undefined;
}

function strOr(source: EnvSource, name: string, fallback: string): string {
  return str(source, name) ?? fallback;
}

function intOr(source: EnvSource, name: string, fallback: number): number {
  const raw = str(source, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${name}: ${JSON.stringify(raw)}`);
  }
  return n;
}

function positiveIntOr(source: EnvSource, name: string, fallback: number): number {
  const value = intOr(source, name, fallback);
  if (value <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalPositiveIntString(source: EnvSource, name: string): string | undefined {
  const raw = str(source, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${JSON.stringify(raw)}`);
  }
  return String(n);
}

function boolOr(source: EnvSource, name: string, fallback: boolean): boolean {
  const raw = str(source, name);
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true";
}

export function loadEnv(source: EnvSource = process.env): Env {
  return {
    nodeEnv: strOr(source, "NODE_ENV", "production"),
    serviceName: strOr(source, "SERVICE_NAME", "livekit-ai-interview-agent"),
    logLevel: strOr(source, "LOG_LEVEL", "info"),

    maxConcurrentInterviews: intOr(source, "MAX_CONCURRENT_INTERVIEWS", 8),
    numIdleProcesses: intOr(source, "NUM_IDLE_PROCESSES", 3),
    drainTimeoutSeconds: intOr(source, "DRAIN_TIMEOUT_SECONDS", 3900),

    geminiContextWindowCompressionEnabled: boolOr(
      source,
      "GEMINI_CONTEXT_WINDOW_COMPRESSION_ENABLED",
      true,
    ),
    geminiContextWindowCompressionTriggerTokens: optionalPositiveIntString(
      source,
      "GEMINI_CONTEXT_WINDOW_COMPRESSION_TRIGGER_TOKENS",
    ),

    webhookMaxRetries: intOr(source, "WEBHOOK_MAX_RETRIES", 3),
    webhookRetryBaseMs: intOr(source, "WEBHOOK_RETRY_BASE_MS", 1000),

    reconnectMaxRetries: intOr(source, "RECONNECT_MAX_RETRIES", 3),
    recoveryMaxTurns: positiveIntOr(source, "RECOVERY_MAX_TURNS", 24),
    recoveryMaxChars: positiveIntOr(source, "RECOVERY_MAX_CHARS", 24_000),
    forwardAudioIdleTimeoutMs: intOr(source, "FORWARD_AUDIO_IDLE_TIMEOUT_MS", 300_000),

    recordingRequired: boolOr(source, "RECORDING_REQUIRED", false),

    monitoringPort: intOr(source, "MONITORING_PORT", 8080),
    monitoringHost: strOr(source, "MONITORING_HOST", "0.0.0.0"),

    livekitUrl: str(source, "LIVEKIT_URL"),
    livekitApiKey: str(source, "LIVEKIT_API_KEY"),
    livekitApiSecret: str(source, "LIVEKIT_API_SECRET"),
    openaiApiKey: str(source, "OPENAI_API_KEY"),
    openaiRealtimeVoice: str(source, "OPENAI_REALTIME_VOICE"),
    googleApiKey: str(source, "GOOGLE_API_KEY"),
    googleRealtimeVoice: str(source, "GOOGLE_REALTIME_VOICE"),
    googleGenaiUseVertexai: boolOr(source, "GOOGLE_GENAI_USE_VERTEXAI", false),
    googleCloudProject: str(source, "GOOGLE_CLOUD_PROJECT"),
    googleCloudLocation: str(source, "GOOGLE_CLOUD_LOCATION"),
    awsRegion: str(source, "AWS_REGION"),
    awsAccessKeyId: str(source, "AWS_ACCESS_KEY_ID"),
    awsSecretAccessKey: str(source, "AWS_SECRET_ACCESS_KEY"),
    recordingS3Bucket: str(source, "RECORDING_S3_BUCKET"),
    redisUrl: str(source, "REDIS_URL"),
    webhookUrl: str(source, "WEBHOOK_URL"),
    otelExporterOtlpEndpoint: str(source, "OTEL_EXPORTER_OTLP_ENDPOINT"),
  };
}
