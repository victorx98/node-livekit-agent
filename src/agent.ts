import { defineAgent, voice, type JobContext, type JobProcess } from "@livekit/agents";
import { RoomEvent } from "@livekit/rtc-node";
import { resolveJobConfig } from "./config/resolveConfig.js";
import { buildInterviewInstructions } from "./interview/buildInstructions.js";
import { assertProviderAllowed, createRealtimeModel } from "./providers/createRealtimeModel.js";
import { createInitialState, appendTurn, type InterviewState } from "./interview/interviewState.js";
import { chatRoleToTranscriptRole } from "./interview/transcriptStore.js";
import { RedisJobTracker } from "./ops/jobTracker.js";
import { getRedis } from "./state/redisClient.js";
import { RedisStore } from "./state/redisStore.js";
import { logger } from "./ops/logger.js";

// Phase 2: durable state. The worker joins the room, seeds the interviewer, runs
// the realtime session, and writes interview state + transcript through to Redis
// on every turn so a crash leaves recoverable state. Still no reconnect/reseed
// (Phase 3) and no recording (later) — persistence only.

export default defineAgent({
  prewarm: (_proc: JobProcess) => {
    // Keep light. The realtime session and Redis store are created per job.
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

    const roomName = ctx.room.name ?? cfg.job_id;
    const store = new RedisStore(getRedis());
    const tracker = new RedisJobTracker(store);

    await tracker.create(cfg.job_id, {
      room: ctx.room.name,
      provider: cfg.model_provider,
      model: cfg.model,
      status: "starting",
    });

    // Deterministic interview state, write-through to Redis from the start so a
    // crash mid-interview leaves something to recover from.
    let state: InterviewState = createInitialState({
      jobId: cfg.job_id,
      interviewId: cfg.interview_id,
      questionCount: cfg.interview.questions.length,
      now: new Date().toISOString(),
    });
    await store.saveInterviewState(state);

    // Serialize Redis writes so concurrent turn events can't interleave a
    // read-modify-write of the in-memory state. Write failures are logged, never
    // swallowed silently, and must not abort the live interview.
    let writeChain: Promise<void> = Promise.resolve();
    const enqueueWrite = (fn: () => Promise<void>): void => {
      writeChain = writeChain.then(fn).catch((err: unknown) => {
        log.error({ event: "redis_write_failed", err }, "failed to persist turn");
      });
    };

    const persistTurn = async (role: string, text: string, at: string): Promise<void> => {
      const speaker = chatRoleToTranscriptRole(role);
      await store.appendTranscript({
        jobId: cfg.job_id,
        interviewId: cfg.interview_id,
        room: roomName,
        role: speaker,
        text,
        at,
      });
      if (speaker === "interviewer" || speaker === "candidate") {
        state = appendTurn(state, { role: speaker, text, at });
        await store.saveInterviewState(state);
        await tracker.update(cfg.job_id, { turns: state.stats.turns, lastActivityAt: at });
      }
    };

    try {
      await ctx.connect();
      await tracker.update(cfg.job_id, { status: "connected" });
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

      // Capture every conversation turn before starting, so the opening greeting
      // is persisted too.
      session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
        const item = ev.item;
        if (item.type !== "message") return;
        const text = item.textContent;
        if (!text) return;
        enqueueWrite(() => persistTurn(item.role, text, new Date(ev.createdAt).toISOString()));
      });

      await session.start({ agent, room: ctx.room });
      await tracker.update(cfg.job_id, {
        status: "in_progress",
        lastActivityAt: new Date().toISOString(),
      });
      log.info({ event: "interview_started" }, "realtime session started");

      // Open the interview once the candidate is present. autoStart=false means
      // the backend wants to gate the first turn on an external signal; Phase 2
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
      await writeChain; // drain pending turn writes before finalizing
      await tracker.update(cfg.job_id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      log.info({ event: "job_completed", turns: state.stats.turns }, "interview completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ event: "job_failed", err }, "interview job failed");
      await tracker.update(cfg.job_id, {
        status: "failed",
        error: message,
        endedAt: new Date().toISOString(),
      });
      throw err;
    } finally {
      // Apply the completion TTL so finished interviews stay inspectable then
      // clean up. On a hard crash this never runs, so state persists for recovery.
      await writeChain;
      await store
        .finalize(cfg.job_id)
        .catch((err: unknown) =>
          log.error({ event: "redis_write_failed", err }, "finalize failed"),
        );
    }
  },
});

/**
 * Resolve when the interview should end: the room disconnects, the last remote
 * participant (the candidate) leaves, or the duration ceiling is reached.
 * The ceiling is capped below the provider hard limit; in Phase 2 it is still
 * the only safeguard (no reconnect).
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
