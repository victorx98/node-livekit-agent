// Worker launcher (parent process). Runs the LiveKit Agents CLI (subcommands:
// dev | start | connect --room <name>) pointed at the agent job module
// (agent.ts), and adds the production-ops layer around it (§18–§20):
//
//   - an explicit per-worker concurrency cap (loadFunc + loadThreshold),
//   - a small monitoring API (readiness/jobs) on its own port,
//   - OpenTelemetry metrics/traces,
//   - a drain-aware readiness flip on SIGTERM (the framework itself drains
//     active interviews before exiting; see §19).
//
// Two-file split on purpose: cli.runApp executes only in this parent process,
// while LiveKit's job subprocesses import agent.js (default export only), so
// runApp never re-runs in a child.
//
// Run with .env loaded, e.g.:  node --env-file=.env dist/main.js start

import { cli, WorkerOptions, type AgentServer } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { logger } from "./ops/logger.js";
import { computeLoad, loadThresholdFor } from "./ops/loadFunc.js";
import { ReadinessState } from "./ops/readiness.js";
import { startMonitoringServer } from "./ops/monitoring/server.js";
import { startTelemetry, observeWorkerLoad } from "./ops/telemetry.js";
import { RedisJobTracker } from "./ops/jobTracker.js";
import { getRedis } from "./state/redisClient.js";
import { RedisStore } from "./state/redisStore.js";

const env = loadEnv();
const agentName = process.env.AGENT_NAME ?? "interview-agent";
const agentPath = fileURLToPath(new URL("./agent.js", import.meta.url));
const max = env.maxConcurrentInterviews;

async function bootstrap(): Promise<void> {
  const readiness = new ReadinessState();

  // Worker-level load sample, refreshed by loadFunc and read by the OTel gauges.
  const sample = { active: 0, ratio: 0 };

  const telemetry = await startTelemetry({
    serviceName: env.serviceName,
    endpoint: env.otelExporterOtlpEndpoint,
    withTraces: true,
  });
  observeWorkerLoad(telemetry, {
    activeJobs: () => sample.active,
    loadRatio: () => sample.ratio,
  });

  // The monitoring API reads the same Redis-backed tracker the children write to,
  // so it can report on jobs running in child processes (§17, §20).
  const tracker = new RedisJobTracker(new RedisStore(getRedis()));
  const monitoring = await startMonitoringServer({
    host: env.monitoringHost,
    port: env.monitoringPort,
    deps: { tracker, readiness },
    log: logger,
  });

  const shutdown = async (): Promise<void> => {
    await monitoring
      .close()
      .catch((err: unknown) => logger.error({ err }, "monitoring close failed"));
    await telemetry
      .shutdown()
      .catch((err: unknown) => logger.error({ err }, "telemetry shutdown failed"));
  };

  // Flip readiness on SIGTERM/SIGINT so the load balancer drains this replica.
  // The framework's own handler then drains active interviews and exits; we add
  // an env-bounded backstop that force-exits if draining overruns the budget.
  const beginDrain = (signal: string): void => {
    if (!readiness.isReady()) return;
    readiness.beginDraining();
    logger.info(
      { event: "worker_drain_started", signal, drain_timeout_seconds: env.drainTimeoutSeconds },
      "draining: stopped accepting new jobs; letting active interviews finish",
    );
    const backstop = setTimeout(() => {
      logger.warn(
        { event: "worker_drain_timeout", drain_timeout_seconds: env.drainTimeoutSeconds },
        "drain budget exceeded; forcing shutdown",
      );
      void shutdown().finally(() => process.exit(143));
    }, env.drainTimeoutSeconds * 1000);
    // Don't let the backstop timer itself keep the process alive.
    backstop.unref();
  };

  process.on("SIGTERM", () => beginDrain("SIGTERM"));
  process.on("SIGINT", () => beginDrain("SIGINT"));

  logger.info(
    {
      event: "worker_started",
      phase: "phase-5-production-ops",
      agentName,
      maxConcurrentInterviews: max,
      monitoringPort: monitoring.port,
      telemetry: env.otelExporterOtlpEndpoint ? "otlp" : "disabled",
    },
    "starting LiveKit interview agent worker",
  );

  cli.runApp(
    new WorkerOptions({
      agent: agentPath,
      // Explicit dispatch: jobs arrive only via AgentDispatchClient targeting this
      // agentName, which lets us attach per-interview metadata (scripts/dispatch.mjs).
      agentName,
      numIdleProcesses: env.numIdleProcesses,
      // Explicit per-worker concurrency cap (§18): report load so the worker
      // marks itself full at `max` instead of drifting on CPU. The real cap is
      // found by load testing; this enforces whatever value is configured.
      loadFunc: async (server: AgentServer) => {
        const active = server.activeJobs?.length ?? 0;
        sample.active = active;
        sample.ratio = computeLoad(active, max);
        return sample.ratio;
      },
      loadThreshold: loadThresholdFor(max),
    }),
  );
}

bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, "worker bootstrap failed");
  process.exit(1);
});
