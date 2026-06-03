import * as google from "@livekit/agents-plugin-google";
import type { RealtimeProvider } from "./types.js";
import type { Env } from "../config/env.js";

type GoogleRealtimeOptions = NonNullable<
  ConstructorParameters<typeof google.realtime.RealtimeModel>[0]
>;
type ContextWindowCompressionConfig = GoogleRealtimeOptions["contextWindowCompression"];

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
      language: cfg.language,
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
