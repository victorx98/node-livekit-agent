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

  // provider gating (§15)
  geminiEnabled: boolean;
  geminiMaxMinutes: number;

  // webhook (§17)
  webhookMaxRetries: number;
  webhookRetryBaseMs: number;

  // reconnect/reseed (§13)
  reconnectMaxRetries: number;

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
  googleApiKey?: string;
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

    geminiEnabled: boolOr(source, "GEMINI_ENABLED", false),
    geminiMaxMinutes: intOr(source, "GEMINI_MAX_MINUTES", 10),

    webhookMaxRetries: intOr(source, "WEBHOOK_MAX_RETRIES", 3),
    webhookRetryBaseMs: intOr(source, "WEBHOOK_RETRY_BASE_MS", 1000),

    reconnectMaxRetries: intOr(source, "RECONNECT_MAX_RETRIES", 3),

    recordingRequired: boolOr(source, "RECORDING_REQUIRED", false),

    monitoringPort: intOr(source, "MONITORING_PORT", 8080),
    monitoringHost: strOr(source, "MONITORING_HOST", "0.0.0.0"),

    livekitUrl: str(source, "LIVEKIT_URL"),
    livekitApiKey: str(source, "LIVEKIT_API_KEY"),
    livekitApiSecret: str(source, "LIVEKIT_API_SECRET"),
    openaiApiKey: str(source, "OPENAI_API_KEY"),
    googleApiKey: str(source, "GOOGLE_API_KEY"),
    awsRegion: str(source, "AWS_REGION"),
    awsAccessKeyId: str(source, "AWS_ACCESS_KEY_ID"),
    awsSecretAccessKey: str(source, "AWS_SECRET_ACCESS_KEY"),
    recordingS3Bucket: str(source, "RECORDING_S3_BUCKET"),
    redisUrl: str(source, "REDIS_URL"),
    webhookUrl: str(source, "WEBHOOK_URL"),
    otelExporterOtlpEndpoint: str(source, "OTEL_EXPORTER_OTLP_ENDPOINT"),
  };
}
