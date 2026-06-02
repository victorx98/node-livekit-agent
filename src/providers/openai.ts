import * as openai from "@livekit/agents-plugin-openai";
import type { RealtimeProvider } from "./types.js";
import type { ResolvedJobConfig } from "../types/config.js";

type RealtimeTuning = ResolvedJobConfig["realtime"];
type TurnDetection = openai.realtime.TurnDetectionType;

export function buildOpenAITurnDetection(rt: RealtimeTuning): TurnDetection {
  if (rt.turn_detection === "server_vad") {
    return {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: rt.silence_duration_ms,
      create_response: true,
      interrupt_response: rt.interrupt_response,
    };
  }
  return {
    type: "semantic_vad",
    eagerness: "medium",
    create_response: true,
    interrupt_response: rt.interrupt_response,
  };
}

export const openaiProvider: RealtimeProvider = {
  id: "openai",

  assertConfig({ env }) {
    if (!env.openaiApiKey) {
      throw new Error("OpenAI realtime requires OPENAI_API_KEY.");
    }
  },

  createModel({ cfg, env }) {
    return new openai.realtime.RealtimeModel({
      model: cfg.model,
      voice: env.openaiRealtimeVoice ?? cfg.voice ?? "marin",
      turnDetection: buildOpenAITurnDetection(cfg.realtime),
      apiKey: env.openaiApiKey,
    });
  },
};
