import * as google from "@livekit/agents-plugin-google";
import type { RealtimeProvider } from "./types.js";

const UNSUPPORTED_GENERATE_REPLY_MODELS = new Set(["gemini-3.1-flash-live-preview"]);

function hasVertexAuth(env: {
  googleGenaiUseVertexai?: boolean;
  googleCloudProject?: string;
}): boolean {
  return env.googleGenaiUseVertexai === true && !!env.googleCloudProject;
}

export const googleProvider: RealtimeProvider = {
  id: "google",

  assertConfig({ cfg, env }) {
    if (cfg.interview.duration_minutes > env.geminiMaxMinutes) {
      throw new Error(
        `Gemini limited to ${env.geminiMaxMinutes} min until session resumption + context ` +
          "compression are verified. Use OpenAI for longer interviews.",
      );
    }

    if (UNSUPPORTED_GENERATE_REPLY_MODELS.has(cfg.model)) {
      throw new Error(
        `${cfg.model} does not support generateReply() in the current LiveKit AgentSession flow.`,
      );
    }

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
    });
  },
};
