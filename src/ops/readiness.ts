// Drain-aware readiness (§19). A replica is "ready" until it begins draining on
// SIGTERM; flipping readiness makes the load balancer stop routing new traffic
// here while in-flight interviews finish. Liveness (/healthz) stays up during
// draining — the process is healthy, just no longer accepting new work.

export type ReadinessStatus = "ready" | "draining";

export class ReadinessState {
  private draining = false;

  isReady(): boolean {
    return !this.draining;
  }

  status(): ReadinessStatus {
    return this.draining ? "draining" : "ready";
  }

  /** Mark the replica as draining; idempotent. */
  beginDraining(): void {
    this.draining = true;
  }
}
