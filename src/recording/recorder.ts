// Recording controller (§16). Owns the required-vs-degrade policy and safe stop.
// It performs no I/O directly — it depends only on injected effects (an S3
// preflight thunk and an EgressGateway), so the policy stays unit-testable with
// fakes and this module imports neither LiveKit nor the AWS SDK.

export interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Egress lifecycle the recorder needs; implemented by the LiveKit adapter. */
export interface EgressGateway {
  /** Start a recording for the room; resolves to the egress id. */
  start(roomName: string, filepath: string, audioOnly: boolean): Promise<string>;
  /** Stop a recording by id. May reject if it already stopped. */
  stop(egressId: string): Promise<void>;
}

export type RecordingStatus = "disabled" | "active" | "failed";

export interface RecordingResult {
  status: RecordingStatus;
  egressId?: string;
}

/** The resolved recording decision for one job (from cfg + recordingPlan). */
export interface RecorderPlan {
  enabled: boolean;
  required: boolean;
  filepath: string;
  audioOnly: boolean;
}

export interface RecorderDeps {
  plan: RecorderPlan;
  roomName: string;
  /** S3 reachability/permission check; throws on failure. */
  preflight: () => Promise<void>;
  gateway: EgressGateway;
  log: MinimalLogger;
}

export class Recorder {
  constructor(private readonly deps: RecorderDeps) {}

  /**
   * Preflight S3 and start the Egress before the interview.
   *
   * Failure policy (§16): when recording is `required`, any failure rethrows so
   * the caller fails the job before the interview starts. When it is not
   * required, the failure is logged and the recording is marked `failed` so the
   * interview can continue without a recording.
   */
  async start(): Promise<RecordingResult> {
    const { plan, roomName, preflight, gateway, log } = this.deps;

    if (!plan.enabled) {
      log.info({ event: "recording_disabled" }, "recording not enabled for this job");
      return { status: "disabled" };
    }

    try {
      await preflight();
      const egressId = await gateway.start(roomName, plan.filepath, plan.audioOnly);
      log.info(
        { event: "recording_started", egressId, filepath: plan.filepath },
        "recording started",
      );
      return { status: "active", egressId };
    } catch (err) {
      if (plan.required) {
        log.error(
          { event: "recording_failed", required: true, err },
          "recording is required but could not start; failing the job",
        );
        throw err;
      }
      log.warn(
        { event: "recording_failed", required: false, err },
        "recording failed to start; continuing without a recording",
      );
      return { status: "failed" };
    }
  }

  /**
   * Stop the Egress, ignoring an already-stopped error: when the room ends, the
   * egress often stops on its own, so a stop call can race and reject. We log it
   * (never silently swallow) but do not propagate — teardown must not fail here.
   */
  async stop(egressId: string): Promise<void> {
    try {
      await this.deps.gateway.stop(egressId);
      this.deps.log.info({ event: "recording_stopped", egressId }, "recording stopped");
    } catch (err) {
      this.deps.log.warn(
        { event: "recording_stop_ignored", egressId, err },
        "stop egress failed (likely already stopped); ignoring",
      );
    }
  }
}
