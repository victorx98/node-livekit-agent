import type { ReseedSeed } from "./reseed.js";

// Reconnect/reseed controller (§13). Provider plugins may recover transient
// socket drops themselves. This controller handles the *fatal* path the
// framework cannot: when a session ends in error, it builds a fresh session
// reseeded from durable state and continues, up to a retry cap. It depends only
// on injected effects (no LiveKit, no Redis), so the reconnect loop is
// unit-testable with fault injection.

export type SessionOutcome = { kind: "ended" } | { kind: "failed"; error?: unknown };

/** A single realtime session attempt the controller can run and await. */
export interface ManagedSession {
  start(): Promise<void>;
  /** Resolves when the session ends normally (`ended`) or fails fatally (`failed`). */
  done(): Promise<SessionOutcome>;
  close(): Promise<void>;
}

export interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ContextManagerDeps {
  /** Build the seed for an attempt; `isReseed` is true for every retry. */
  buildSeed: (isReseed: boolean) => ReseedSeed;
  /** Create a fresh session for the given seed. */
  createSession: (seed: ReseedSeed) => Promise<ManagedSession>;
  /** Side effect run before each reconnect attempt (persist reconnect count, etc.). */
  onReconnect: (attempt: number) => Promise<void>;
  /** Maximum reconnect attempts after the initial session before giving up. */
  maxReconnects: number;
  log: MinimalLogger;
}

export class ContextManager {
  constructor(private readonly deps: ContextManagerDeps) {}

  /**
   * No-op rotation hook (§13, deferred). Proactive session rotation on a healthy
   * session is not yet proven, so this is intentionally inert; it marks where
   * rotation would slot in beside reconnect/reseed.
   */
  maybeRotate(): void {
    // Intentionally empty until a spike validates seamless model swapping.
  }

  /**
   * Run sessions until one completes normally, or the reconnect cap is exceeded.
   * Each retry reseeds from durable state via `buildSeed(true)`.
   */
  async run(): Promise<void> {
    const { buildSeed, createSession, onReconnect, maxReconnects, log } = this.deps;

    let attempt = 0;
    for (;;) {
      const isReseed = attempt > 0;
      if (isReseed) {
        await onReconnect(attempt);
        log.info(
          { event: "provider_reconnect_started", attempt },
          "reconnecting and reseeding from durable state",
        );
      }

      const seed = buildSeed(isReseed);
      const session = await createSession(seed);

      let outcome: SessionOutcome;
      try {
        await session.start();
        if (isReseed) {
          log.info({ event: "provider_reconnect_completed", attempt }, "reseeded session is live");
        }
        outcome = await session.done();
      } catch (error) {
        // A throw while starting/running counts as a fatal failure for this attempt.
        outcome = { kind: "failed", error };
      } finally {
        try {
          await session.close();
        } catch (closeError) {
          log.error({ event: "session_close_failed", err: closeError }, "failed to close session");
        }
      }

      if (outcome.kind === "ended") return;

      log.warn(
        { event: "provider_session_failed", attempt, err: outcome.error },
        "realtime session failed",
      );

      attempt += 1;
      if (attempt > maxReconnects) {
        throw new Error(`Reconnect attempts exhausted after ${maxReconnects}`);
      }
    }
  }
}
