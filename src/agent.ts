import { defineAgent, voice, type JobContext, type JobProcess } from "@livekit/agents";
import { RoomEvent } from "@livekit/rtc-node";
import { resolveJobConfig } from "./config/resolveConfig.js";
import { loadEnv } from "./config/env.js";
import { assertProviderAllowed, createRealtimeModel } from "./providers/createRealtimeModel.js";
import { createInitialState, appendTurn, type InterviewState } from "./interview/interviewState.js";
import { chatRoleToTranscriptRole } from "./interview/transcriptStore.js";
import { buildReseedContext } from "./interview/reseed.js";
import {
  ContextManager,
  type ManagedSession,
  type SessionOutcome,
} from "./interview/contextManager.js";
import { RedisJobTracker } from "./ops/jobTracker.js";
import { getRedis } from "./state/redisClient.js";
import { RedisStore } from "./state/redisStore.js";
import { logger } from "./ops/logger.js";

// Phase 3: reconnect + reseed. The worker joins the room and runs the interview
// through a ContextManager. The OpenAI plugin transparently reconnects transient
// socket drops (replaying its in-memory context); when a session fails fatally
// (AgentSession closes with CloseReason.ERROR) the ContextManager opens a fresh
// session reseeded from the durable Redis recap and continues, up to a retry
// cap. Interview state + transcript are still written through to Redis per turn.

export default defineAgent({
  prewarm: (_proc: JobProcess) => {
    // Keep light. The realtime session and Redis store are created per job.
  },

  entry: async (ctx: JobContext): Promise<void> => {
    const cfg = resolveJobConfig(ctx.job?.metadata ?? "{}", ctx.job?.id ?? ctx.room.name);
    assertProviderAllowed(cfg); // OpenAI passes; unverified Gemini is rejected (§15)
    const env = loadEnv();

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

    // Deterministic interview state shared across reconnects, write-through to
    // Redis so a reseed (or crash-and-retry) can rebuild context.
    let state: InterviewState = createInitialState({
      jobId: cfg.job_id,
      interviewId: cfg.interview_id,
      questionCount: cfg.interview.questions.length,
      now: new Date().toISOString(),
    });
    await store.saveInterviewState(state);

    // Serialize all state writes (turns and reconnect bookkeeping) so they can't
    // interleave a read-modify-write. Failures are logged, never swallowed, and
    // must not abort the live interview.
    let writeChain: Promise<void> = Promise.resolve();
    const enqueueWrite = (fn: () => Promise<void>): void => {
      writeChain = writeChain.then(fn).catch((err: unknown) => {
        log.error({ event: "redis_write_failed", err }, "failed to persist state");
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

      // One promise bounds the whole interview (room end or duration cap),
      // independent of how many realtime sessions are spun up by reconnects.
      const interviewEnded = waitForRoomEndOrTimeout(ctx, cfg.interview.duration_minutes);

      const createSession = async (seed: {
        instructions: string;
        recap?: string;
      }): Promise<ManagedSession> => {
        const isReseed = seed.recap !== undefined;
        const instructions = isReseed ? `${seed.instructions}\n\n${seed.recap}` : seed.instructions;

        const model = createRealtimeModel({
          provider: cfg.model_provider,
          model: cfg.model,
          voice: cfg.voice,
          instructions,
          realtime: cfg.realtime,
        });
        const agent = new voice.Agent({ instructions });
        const session = new voice.AgentSession({ llm: model });

        // Capture every conversation turn (write-through). Subscribing before
        // start captures the opening line too.
        session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
          const item = ev.item;
          if (item.type !== "message") return;
          const text = item.textContent;
          if (!text) return;
          enqueueWrite(() => persistTurn(item.role, text, new Date(ev.createdAt).toISOString()));
        });

        // A fatal close (CloseReason.ERROR) means the plugin exhausted its own
        // retries; treat it as a failure so the ContextManager reseeds.
        let resolveClosed: (outcome: SessionOutcome) => void = () => {};
        const closed = new Promise<SessionOutcome>((resolve) => {
          resolveClosed = resolve;
        });
        session.on(voice.AgentSessionEventTypes.Close, (ev) => {
          resolveClosed(
            ev.reason === voice.CloseReason.ERROR
              ? { kind: "failed", error: ev.error }
              : { kind: "ended" },
          );
        });

        return {
          start: async () => {
            await session.start({ agent, room: ctx.room });
            await tracker.update(cfg.job_id, {
              status: "in_progress",
              lastActivityAt: new Date().toISOString(),
            });
            log.info({ event: "interview_started", reseed: isReseed }, "realtime session started");

            if (cfg.options.autoStart) {
              ctx
                .waitForParticipant()
                .then(() => {
                  const opener = isReseed
                    ? "Continue the interview from where you left off; do not restart or re-introduce yourself."
                    : "Greet the candidate briefly, then ask your first planned question.";
                  session.generateReply({ instructions: opener });
                })
                .catch((err: unknown) => log.warn({ err }, "no candidate joined to greet"));
            }
          },
          // Resolve on whichever happens first: the whole interview ending, or
          // this session closing (fatal -> failed, otherwise ended).
          done: () =>
            Promise.race([closed, interviewEnded.then((): SessionOutcome => ({ kind: "ended" }))]),
          close: async () => {
            await session.close();
          },
        };
      };

      const ctxMgr = new ContextManager({
        buildSeed: (isReseed) => buildReseedContext(cfg, state, isReseed),
        createSession,
        onReconnect: async (attempt) => {
          enqueueWrite(async () => {
            state = { ...state, stats: { ...state.stats, reconnects: attempt } };
            await store.saveInterviewState(state);
          });
          await writeChain; // ensure the bumped state is persisted before reseed reads it
          await tracker.update(cfg.job_id, { status: "reconnecting", reconnects: attempt });
        },
        maxReconnects: env.reconnectMaxRetries,
        log,
      });

      await ctxMgr.run();
      log.info({ event: "interview_ended" }, "room ended or duration reached");

      await writeChain; // drain pending turn writes before finalizing
      await tracker.update(cfg.job_id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      log.info(
        { event: "job_completed", turns: state.stats.turns, reconnects: state.stats.reconnects },
        "interview completed",
      );
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
 * participant (the candidate) leaves, or the duration ceiling is reached. The
 * ceiling is capped below the provider hard limit. This bounds the whole
 * interview across any number of reconnect-driven sessions.
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
