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
import { Recorder, type RecordingResult } from "./recording/recorder.js";
import { resolveRecordingFilepath } from "./recording/recordingPlan.js";
import { LiveKitEgressGateway } from "./recording/egressGateway.js";
import { createS3Preflight } from "./recording/s3Preflight.js";
import { sendWebhook, type WebhookEvent } from "./ops/webhook.js";
import { getChildMetrics } from "./ops/telemetry.js";

// Phase 4: recording + final webhook. On top of Phase 3 (reconnect + reseed),
// the worker runs an S3 preflight and starts a LiveKit Egress before the
// interview (required-vs-degrade per RECORDING_REQUIRED, §16), stops the egress
// on teardown, and emits exactly one final-state webhook — job_completed or
// job_failed — with a bounded retry (§17). Webhook delivery never crashes
// teardown. The Phase 3 ContextManager + per-turn Redis write-through are intact.

export default defineAgent({
  prewarm: (_proc: JobProcess) => {
    // Keep light. The realtime session and Redis store are created per job.
  },

  entry: async (ctx: JobContext): Promise<void> => {
    const jobStartMs = Date.now();
    const cfg = resolveJobConfig(ctx.job?.metadata ?? "{}", ctx.job?.id ?? ctx.room.name);
    assertProviderAllowed(cfg); // OpenAI passes; unverified Gemini is rejected (§15)
    const env = loadEnv();

    // Per-process metrics (§20); started once per child and reused across jobs.
    const metrics = await getChildMetrics(env.serviceName, env.otelExporterOtlpEndpoint);
    const jobLabels = { provider: cfg.model_provider, model: cfg.model };

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
    metrics.jobStarted(jobLabels);

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
        metrics.redisWriteFailed();
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

    // Recording (§16). The Recorder owns the required-vs-degrade policy; the
    // S3/LiveKit I/O lives behind injected adapters. Built up front so teardown
    // (in `finally`) can stop the egress regardless of how the job ended.
    const filepath = resolveRecordingFilepath(cfg);
    const recorder = new Recorder({
      plan: {
        enabled: cfg.recording.enabled,
        required: cfg.recording.required,
        filepath,
        audioOnly: cfg.recording.audio_only,
      },
      roomName,
      preflight: createS3Preflight({
        region: env.awsRegion ?? cfg.recording.s3_region,
        accessKeyId: env.awsAccessKeyId ?? "",
        secretAccessKey: env.awsSecretAccessKey ?? "",
        bucket: cfg.recording.s3_bucket,
        key: filepath,
      }),
      gateway: new LiveKitEgressGateway({
        livekitUrl: env.livekitUrl ?? "",
        livekitApiKey: env.livekitApiKey ?? "",
        livekitApiSecret: env.livekitApiSecret ?? "",
        s3: {
          accessKeyId: env.awsAccessKeyId ?? "",
          secretAccessKey: env.awsSecretAccessKey ?? "",
          bucket: cfg.recording.s3_bucket,
          region: env.awsRegion ?? cfg.recording.s3_region,
        },
      }),
      log,
    });
    let recording: RecordingResult = { status: "disabled" };

    // Final-state webhook event (§17). Default to failed; only the clean
    // completion path flips it to job_completed. Emitted once, in `finally`.
    let finalEvent: WebhookEvent = "job_failed";

    try {
      await ctx.connect();
      await tracker.update(cfg.job_id, { status: "connected" });
      log.info({ event: "room_connected" }, "agent connected to room");

      // Preflight + start recording before the interview. When recording is
      // required this throws on failure (caught below -> job_failed); otherwise
      // it degrades to "failed" and the interview continues without a recording.
      recording = await recorder.start();
      await tracker.update(cfg.job_id, {
        egressId: recording.egressId,
        recording: recording.status,
      });
      if (recording.status === "active") metrics.recordingStarted();
      else if (recording.status === "failed") metrics.recordingStartFailed();

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
          metrics.providerReconnect(jobLabels);
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
      finalEvent = "job_completed";
      metrics.jobCompleted(jobLabels);
      metrics.jobDurationSeconds((Date.now() - jobStartMs) / 1000, jobLabels);
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
      metrics.jobFailed({ ...jobLabels, reason: classifyFailure(message) });
      throw err;
    } finally {
      await writeChain;

      // Stop the egress (safe: ignores an already-stopped race when the room
      // ended on its own) and reflect the stopped state on the job record.
      if (recording.egressId) {
        await recorder.stop(recording.egressId);
        await tracker
          .update(cfg.job_id, { recording: "stopped" })
          .catch((err: unknown) =>
            log.error({ event: "redis_write_failed", err }, "recording-stopped update failed"),
          );
      }

      // Apply the completion TTL so finished interviews stay inspectable then
      // clean up. On a hard crash this never runs, so state persists for recovery.
      await store
        .finalize(cfg.job_id)
        .catch((err: unknown) =>
          log.error({ event: "redis_write_failed", err }, "finalize failed"),
        );

      // Emit exactly one final-state webhook from the durable record (§17).
      // Best-effort: sendWebhook never throws, so it cannot mask the job result.
      const finalRecord = await tracker.get(cfg.job_id);
      if (finalRecord) {
        const delivery = await sendWebhook({
          url: env.webhookUrl,
          event: finalEvent,
          record: finalRecord,
          maxRetries: env.webhookMaxRetries,
          baseMs: env.webhookRetryBaseMs,
          fetchFn: fetch,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          log,
        });
        if (!delivery.delivered && !delivery.skipped) metrics.webhookFailed();
      }
    }
  },
});

/**
 * Coarse failure reason for the interview_jobs_failed_total metric label. Kept
 * low-cardinality on purpose — full messages go to logs, not metric labels.
 */
function classifyFailure(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("reconnect attempts exhausted")) return "reconnect_exhausted";
  if (m.includes("s3 preflight") || m.includes("recording")) return "recording";
  if (m.includes("gemini")) return "provider_gated";
  if (m.includes("redis")) return "redis";
  return "error";
}

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
