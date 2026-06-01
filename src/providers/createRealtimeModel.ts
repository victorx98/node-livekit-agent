import * as openai from "@livekit/agents-plugin-openai";
import type { ResolvedJobConfig } from "../types/config.js";

// Provider routing (§11). MVP wires OpenAI only; Gemini stays behind the gate
// in assertProviderAllowed and is not constructed in Phase 1 (§15).

type RealtimeTuning = ResolvedJobConfig["realtime"];
type TurnDetection = openai.realtime.TurnDetectionType;

export interface CreateRealtimeModelArgs {
  provider: ResolvedJobConfig["model_provider"];
  model: string;
  voice?: string;
  instructions: string;
  realtime: RealtimeTuning;
}

/**
 * Runtime guard called from the entrypoint. Reads the gating env vars at call
 * time (not import time) so the policy is testable and reflects live config.
 */
export function assertProviderAllowed(cfg: ResolvedJobConfig): void {
  if (cfg.model_provider !== "google") return;

  const enabled = process.env.GEMINI_ENABLED === "true";
  const maxMinutes = Number(process.env.GEMINI_MAX_MINUTES ?? 10);

  if (!enabled) {
    throw new Error("Gemini is disabled (GEMINI_ENABLED=false). Use OpenAI.");
  }
  if (cfg.interview.duration_minutes > maxMinutes) {
    throw new Error(
      `Gemini limited to ${maxMinutes} min until session resumption + context ` +
        `compression are verified (§15). Use OpenAI for 1-hour interviews.`,
    );
  }
}

/** Pure mapping from internal realtime tuning to the OpenAI turn-detection shape. */
export function buildTurnDetection(rt: RealtimeTuning): TurnDetection {
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

export function createRealtimeModel(args: CreateRealtimeModelArgs): openai.realtime.RealtimeModel {
  if (args.provider === "openai") {
    // Instructions are applied to the session via the voice.Agent, not here.
    return new openai.realtime.RealtimeModel({
      model: args.model,
      voice: args.voice ?? "marin",
      turnDetection: buildTurnDetection(args.realtime),
    });
  }
  // Gemini is gated by assertProviderAllowed and not built in Phase 1 (§15).
  throw new Error("Gemini realtime is not wired in Phase 1 (OpenAI only). See §15.");
}
