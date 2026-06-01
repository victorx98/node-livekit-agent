import { pino, type Logger, type DestinationStream } from "pino";
import { loadEnv } from "../config/env.js";

// Structured JSON logging (§20). Base fields (service, env) are attached to
// every line; secret fields are redacted (§21) so credentials never reach the
// log sink even if accidentally included in a log payload.

const REDACT_PATHS = [
  "openaiApiKey",
  "googleApiKey",
  "livekitApiKey",
  "livekitApiSecret",
  "awsAccessKeyId",
  "awsSecretAccessKey",
  "authorization",
  "password",
  // one level of nesting for the same secret-bearing keys
  "*.openaiApiKey",
  "*.googleApiKey",
  "*.livekitApiKey",
  "*.livekitApiSecret",
  "*.awsAccessKeyId",
  "*.awsSecretAccessKey",
  "*.authorization",
  "*.password",
];

export interface LoggerOptions {
  level?: string;
  service?: string;
  env?: string;
}

export function createLogger(options: LoggerOptions = {}, destination?: DestinationStream): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: {
        service: options.service ?? "livekit-ai-interview-agent",
        env: options.env ?? "production",
      },
      redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
    },
    destination,
  );
}

// Default singleton configured from the operational environment (§7).
const env = loadEnv();
export const logger: Logger = createLogger({
  level: env.logLevel,
  service: env.serviceName,
  env: env.nodeEnv,
});
