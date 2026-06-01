// Phase 0 bootstrap. Composes the two tested building blocks — operational env
// loading (config/env.ts) and the structured logger (ops/logger.ts) — and logs
// a resolved-config summary so the container has a runnable, honest entrypoint.
//
// The LiveKit supervisor/worker (agent.ts, prewarm pool, monitoring API,
// draining) is intentionally NOT wired in Phase 0 — see the design's build
// phases. This file grows into the supervisor in a later phase.

import { loadEnv } from "./config/env.js";
import { logger } from "./ops/logger.js";

function main(): void {
  const env = loadEnv();

  logger.info(
    {
      event: "worker_started",
      phase: "phase-0-skeleton",
      maxConcurrentInterviews: env.maxConcurrentInterviews,
      numIdleProcesses: env.numIdleProcesses,
      drainTimeoutSeconds: env.drainTimeoutSeconds,
      geminiEnabled: env.geminiEnabled,
    },
    "Phase 0 skeleton booted; LiveKit worker not wired yet",
  );
}

main();
