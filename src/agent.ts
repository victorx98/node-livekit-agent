import { defineAgent, voice, type JobContext, type JobProcess } from "@livekit/agents";
import { RoomEvent } from "@livekit/rtc-node";
import { resolveJobConfig } from "./config/resolveConfig.js";
import { buildInterviewInstructions } from "./interview/buildInstructions.js";
import { assertProviderAllowed, createRealtimeModel } from "./providers/createRealtimeModel.js";
import { jobTracker } from "./ops/jobTracker.js";
import { logger } from "./ops/logger.js";

// Phase 1 walking skeleton: join the room, seed the interviewer, run the
// realtime session, exit on room end. In-memory job tracker only — no Redis,
// no recording, no reconnect/reseed (those are later hardening phases).

export default defineAgent({
  prewarm: (_proc: JobProcess) => {
    // Keep light. The realtime session is created per job in `entry`.
  },

  entry: async (ctx: JobContext): Promise<void> => {
    const cfg = resolveJobConfig(ctx.job?.metadata ?? "{}", ctx.job?.id ?? ctx.room.name);
    assertProviderAllowed(cfg); // OpenAI passes; unverified Gemini is rejected (§15)

    const log = logger.child({
      job_id: cfg.job_id,
      interview_id: cfg.interview_id,
      provider: cfg.model_provider,
      model: cfg.model,
      room: ctx.room.name,
    });

    await jobTracker.create(cfg.job_id, {
      room: ctx.room.name,
      provider: cfg.model_provider,
      model: cfg.model,
      status: "starting",
    });

    try {
      await ctx.connect();
      await jobTracker.update(cfg.job_id, { status: "connected" });
      log.info({ event: "room_connected" }, "agent connected to room");

      const instructions = buildInterviewInstructions(cfg);
      const model = createRealtimeModel({
        provider: cfg.model_provider,
        model: cfg.model,
        voice: cfg.voice,
        instructions,
        realtime: cfg.realtime,
      });

      const agent = new voice.Agent({ instructions });
      const session = new voice.AgentSession({ llm: model });

      await session.start({ agent, room: ctx.room });
      await jobTracker.update(cfg.job_id, {
        status: "in_progress",
        lastActivityAt: new Date().toISOString(),
      });
      log.info({ event: "interview_started" }, "realtime session started");

      // Open the interview once the candidate is present. autoStart=false means
      // the backend wants to gate the first turn on an external signal; Phase 1
      // has no control channel, so we simply do not auto-greet in that case.
      if (cfg.options.autoStart) {
        ctx
          .waitForParticipant()
          .then(() => {
            log.info({ event: "candidate_joined" }, "candidate present; opening interview");
            session.generateReply({
              instructions: "Greet the candidate briefly, then ask your first planned question.",
            });
          })
          .catch((err: unknown) => log.warn({ err }, "no candidate joined to greet"));
      }

      await waitForRoomEndOrTimeout(ctx, cfg.interview.duration_minutes);
      log.info({ event: "interview_ended" }, "room ended or duration reached");

      await session.close();
      await jobTracker.update(cfg.job_id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      log.info({ event: "job_completed" }, "interview completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ event: "job_failed", err }, "interview job failed");
      await jobTracker.update(cfg.job_id, {
        status: "failed",
        error: message,
        endedAt: new Date().toISOString(),
      });
      throw err;
    }
  },
});

/**
 * Resolve when the interview should end: the room disconnects, the last remote
 * participant (the candidate) leaves, or the duration ceiling is reached.
 * The ceiling is capped below the provider hard limit; in Phase 1 it is the
 * only safeguard (no reconnect).
 */
function waitForRoomEndOrTimeout(ctx: JobContext, durationMinutes: number): Promise<void> {
  const maxMs = Math.min(durationMinutes, 59) * 60_000;
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, maxMs);
    ctx.room.on(RoomEvent.Disconnected, finish);
    ctx.room.on(RoomEvent.ParticipantDisconnected, () => {
      if (ctx.room.remoteParticipants.size === 0) finish();
    });
  });
}
