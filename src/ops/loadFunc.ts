import type { AgentServer } from "@livekit/agents";

// Per-worker concurrency cap (§18). The realtime model does STT/LLM/TTS
// server-side, so each job is memory-bound rather than CPU-bound; relying on CPU
// to drift to a limit is unreliable. Instead we report an explicit load ratio so
// a replica marks itself "full" at MAX_CONCURRENT_INTERVIEWS. The real cap is
// found by load testing (§18 worksheet); this just enforces whatever it is.

/** Load ratio in [0, 1] for `active` concurrent interviews against a `max` cap. */
export function computeLoad(active: number, max: number): number {
  if (max <= 0) {
    throw new Error(`Invalid concurrency cap: ${max} (must be >= 1)`);
  }
  return Math.min(active / max, 1);
}

/**
 * Threshold that makes the worker report "full" exactly at the cap. The
 * framework marks a worker unavailable when load *exceeds* the threshold, so we
 * place it midway between the load at `max - 1` and the load at `max`: load(max)
 * exceeds it (full), load(max - 1) does not (still accepting).
 */
export function loadThresholdFor(max: number): number {
  if (max <= 0) {
    throw new Error(`Invalid concurrency cap: ${max} (must be >= 1)`);
  }
  return (max - 0.5) / max;
}

/** Build the ServerOptions.loadFunc that reads the worker's active job count. */
export function makeLoadFunc(max: number): (server: AgentServer) => Promise<number> {
  return async (server) => computeLoad(server.activeJobs?.length ?? 0, max);
}
