import * as google from "@livekit/agents-plugin-google";
import { ActivityHandling, StartSensitivity, EndSensitivity } from "@google/genai";
import type { RealtimeProvider } from "./types.js";
import type { Env } from "../config/env.js";
import type { ResolvedJobConfig } from "../types/config.js";

type GoogleRealtimeOptions = NonNullable<
  ConstructorParameters<typeof google.realtime.RealtimeModel>[0]
>;
type ContextWindowCompressionConfig = GoogleRealtimeOptions["contextWindowCompression"];
type RealtimeInputConfig = GoogleRealtimeOptions["realtimeInputConfig"];
type RealtimeTuning = ResolvedJobConfig["realtime"];

// Gemini Cloud's default automatic activity detection holds the candidate's
// turn open far too long after they stop, so the reply lags by tens of seconds.
// Configure end-of-speech detection explicitly (parallel to the OpenAI provider's
// buildOpenAITurnDetection), reusing cfg.realtime so both providers share the
// SILENCE_DURATION_MS / INTERRUPT_RESPONSE knobs.
export function buildGeminiRealtimeInputConfig(rt: RealtimeTuning): RealtimeInputConfig {
  return {
    automaticActivityDetection: {
      prefixPaddingMs: 300,
      silenceDurationMs: rt.silence_duration_ms,
      startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
      endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
    },
    activityHandling: rt.interrupt_response
      ? ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
      : ActivityHandling.NO_INTERRUPTION,
  };
}

function hasVertexAuth(env: {
  googleGenaiUseVertexai?: boolean;
  googleCloudProject?: string;
}): boolean {
  return env.googleGenaiUseVertexai === true && !!env.googleCloudProject;
}

export function buildGeminiContextWindowCompression(
  env: Env,
): ContextWindowCompressionConfig | undefined {
  if (!env.geminiContextWindowCompressionEnabled) return undefined;

  const config: NonNullable<ContextWindowCompressionConfig> = {
    slidingWindow: {},
  };

  if (env.geminiContextWindowCompressionTriggerTokens !== undefined) {
    config.triggerTokens = env.geminiContextWindowCompressionTriggerTokens;
  }

  return config;
}

export const googleProvider: RealtimeProvider = {
  id: "google",

  capabilities({ cfg }) {
    return {
      nativeRecovery: "session_resumption",
      // The installed LiveKit Google plugin disables mid-session chat-context
      // updates for 3.1 models, which also blocks generateReply().
      supportsProgrammaticGreeting: !cfg.model.includes("3.1"),
    };
  },

  assertConfig({ env }) {
    if (!env.googleApiKey && !hasVertexAuth(env)) {
      throw new Error(
        "Gemini realtime requires GOOGLE_API_KEY or Vertex AI settings " +
          "(GOOGLE_GENAI_USE_VERTEXAI=true and GOOGLE_CLOUD_PROJECT).",
      );
    }
  },

  createModel({ cfg, env, instructions }) {
    return new google.realtime.RealtimeModel({
      model: cfg.model,
      apiKey: env.googleApiKey,
      voice: env.googleRealtimeVoice,
      realtimeInputConfig: buildGeminiRealtimeInputConfig(cfg.realtime),
      instructions,
      vertexai: env.googleGenaiUseVertexai,
      project: env.googleCloudProject,
      location: env.googleCloudLocation,
      // The LiveKit Google plugin owns session resumption: it stores
      // SessionResumptionUpdate handles, sends sessionResumption on reconnect,
      // and turns GoAway into its internal restart signal.
      contextWindowCompression: buildGeminiContextWindowCompression(env),
    });
  },
};
