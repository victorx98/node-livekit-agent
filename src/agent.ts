import { createHash } from "node:crypto";
import { defineAgent, voice, type JobContext, type JobProcess } from "@livekit/agents";
import { resolveJobConfig } from "./config/resolveConfig.js";
import { extractJobMetadata } from "./config/metadata.js";
import { loadEnv } from "./config/env.js";
import {
  assertProviderAllowed,
  createRealtimeModel,
  getRealtimeProviderCapabilities,
} from "./providers/registry.js";
import { createInitialState, appendTurn, type InterviewState } from "./interview/interviewState.js";
import { chatRoleToTranscriptRole } from "./interview/transcriptStore.js";
import { buildSessionSeed, type RecoveryTranscriptTurn } from "./interview/reseed.js";
import { loadRecoverySource } from "./interview/recoverySource.js";
import {
  candidateIdentityFromParticipantId,
  watchInterviewEnd,
  type InterviewEndReason,
} from "./interview/roomEndWatcher.js";
import { deleteRoomBestEffort } from "./interview/roomTeardown.js";
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
    const extractedMetadata = extractJobMetadata(ctx);
    const cfg = resolveJobConfig(extractedMetadata.metadata, ctx.job?.id ?? ctx.room.name);
    const env = loadEnv();
    assertProviderAllowed({ cfg, env });
    const providerCapabilities = getRealtimeProviderCapabilities({ cfg, env });

    // Per-process metrics (§20); started once per child and reused across jobs.
    const metrics = await getChildMetrics(env.serviceName, env.otelExporterOtlpEndpoint);
    const jobLabels = { provider: cfg.model_provider, model: cfg.model };

    const roomName = resolveAssignedRoomName(ctx);

    const log = logger.child({
      job_id: cfg.job_id,
      interview_id: cfg.interview_id,
      provider: cfg.model_provider,
      model: cfg.model,
      room: roomName,
      metadata_source: extractedMetadata.source,
    });
    log.info(
      {
        event: "interview_instruction_resolved",
        instruction_length: cfg.system_instruction.length,
        instruction_sha256: createHash("sha256")
          .update(cfg.system_instruction, "utf8")
          .digest("hex"),
        instruction_text: cfg.system_instruction,
        native_recovery: providerCapabilities.nativeRecovery,
      },
      "using API-authored interview instruction",
    );

    const store = new RedisStore(getRedis());
    const tracker = new RedisJobTracker(store);

    await tracker.create(cfg.job_id, {
      room: roomName,
      provider: cfg.model_provider,
      model: cfg.model,
      status: "starting",
    });
    await store.saveRecoverySnapshot(cfg.job_id, cfg.recovery_snapshot);
    await store.saveSystemInstruction(cfg.job_id, cfg.system_instruction);
    metrics.jobStarted(jobLabels);

    // Deterministic interview state shared across reconnects, write-through to
    // Redis so a reseed (or crash-and-retry) can rebuild context.
    let state: InterviewState = createInitialState({
      jobId: cfg.job_id,
      interviewId: cfg.interview_id,
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
      log.info(
        {
          event: "room_connected",
          assigned_room: roomName,
          connected_room: ctx.room.name,
        },
        "agent connected to room",
      );
      if (ctx.room.name && ctx.room.name !== roomName) {
        log.warn(
          { event: "room_name_mismatch", assigned_room: roomName, connected_room: ctx.room.name },
          "connected room name differs from assigned job room name",
        );
      }

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

      const candidateIdentity = candidateIdentityFromParticipantId(cfg.participant_id);
      let interviewEndReason: InterviewEndReason | undefined;
      // One promise bounds the whole interview (room end or duration cap),
      // independent of how many realtime sessions are spun up by reconnects.
      const interviewEnded = watchInterviewEnd({
        room: ctx.room,
        durationMinutes: cfg.duration_minutes,
        candidateIdentity,
        absenceGraceMs: env.participantAbsenceGraceMs,
        log,
      }).then((reason) => {
        interviewEndReason = reason;
        return reason;
      });

      const createSession = async (seed: {
        instructions: string;
        chatCtx?: import("@livekit/agents").llm.ChatContext;
        recovered: boolean;
      }): Promise<ManagedSession> => {
        const isReseed = seed.recovered;
        const instructions = seed.instructions;

        const model = createRealtimeModel({
          cfg,
          env,
          instructions,
        });
        const agent = new voice.Agent({
          instructions,
          ...(seed.chatCtx ? { chatCtx: seed.chatCtx } : {}),
        });
        const session = new voice.AgentSession({
          llm: model,
          // Realtime models emit audio only after the candidate finishes
          // speaking; the framework's 10s first-frame timeout would otherwise
          // drop the response to any answer longer than ~10s (§8.3).
          forwardAudioIdleTimeout: env.forwardAudioIdleTimeoutMs,
        });

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
            await session.start({
              agent,
              room: ctx.room,
              inputOptions: {
                participantIdentity: candidateIdentity,
                closeOnDisconnect: false,
              },
            });
            await tracker.update(cfg.job_id, {
              status: "in_progress",
              lastActivityAt: new Date().toISOString(),
            });
            log.info({ event: "interview_started", reseed: isReseed }, "realtime session started");

            if (cfg.options.autoStart) {
              ctx
                .waitForParticipant()
                .then(async () => {
                  if (!providerCapabilities.supportsProgrammaticGreeting) {
                    log.info(
                      {
                        event: "programmatic_greeting_skipped",
                        model: cfg.model,
                        reseed: isReseed,
                      },
                      "model does not support programmatic reply generation; waiting for candidate",
                    );
                    return;
                  }
                  const opener = isReseed
                    ? "Continue the interview from where you left off; do not restart or re-introduce yourself."
                    : cfg.greeting_prompt;
                  await session.generateReply({ instructions: opener });
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

      const recoveryLimits = {
        maxTurns: env.recoveryMaxTurns,
        maxChars: env.recoveryMaxChars,
      };
      const recentTurnsFallback = (): RecoveryTranscriptTurn[] =>
        state.recentTurns.map((turn) => ({
          role: turn.role,
          text: turn.text,
          at: turn.at,
        }));

      const ctxMgr = new ContextManager({
        buildSeed: async (isReseed) => {
          if (!isReseed) {
            return buildSessionSeed(cfg.system_instruction, [], false, recoveryLimits);
          }

          const recovery = await loadRecoverySource({
            jobId: cfg.job_id,
            reader: store,
            fallbackSnapshot: cfg.recovery_snapshot,
            fallbackTranscript: recentTurnsFallback(),
          });
          if (recovery.degraded) {
            log.warn(
              { event: "recovery_context_read_failed", err: recovery.error },
              "using in-memory instruction snapshot and recent turns",
            );
          }

          return buildSessionSeed(
            recovery.snapshot.system_instruction,
            recovery.transcript,
            true,
            recoveryLimits,
          );
        },
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
      log.info(
        {
          event: "interview_ended",
          end_reason: interviewEndReason?.kind ?? "session_closed",
          interview_end_reason: interviewEndReason,
        },
        "room ended or duration reached",
      );

      // The interview is over, but the room may still hold a zombie candidate
      // connection (background tab, locked laptop) that blocks LiveKit's
      // empty-timeout and keeps the room session alive for hours. Delete the
      // room so remaining participants are kicked and room_finished fires.
      // Skip room_disconnected: the room is already gone in that case.
      if (interviewEndReason?.kind !== "room_disconnected") {
        const teardown = await deleteRoomBestEffort({
          roomName,
          livekitUrl: env.livekitUrl,
          livekitApiKey: env.livekitApiKey,
          livekitApiSecret: env.livekitApiSecret,
          log,
        });
        log.info(
          { event: "room_teardown", outcome: teardown, room: roomName },
          "room teardown after interview end",
        );
      }

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

export function resolveAssignedRoomName(ctx: {
  job?: { id?: string; room?: { name?: string | null } | null } | null;
  room?: { name?: string | null } | null;
}): string {
  const roomName = ctx.job?.room?.name?.trim() || ctx.room?.name?.trim();
  if (roomName) return roomName;

  const jobId = ctx.job?.id?.trim() || "unknown";
  throw new Error(`Cannot resolve LiveKit room name for job ${jobId}`);
}

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
