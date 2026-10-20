#!/usr/bin/env node
// Run inside agent-sa2, forwarding this script on stdin. No interview dispatch.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { getChildTelemetry, getActiveTraceFields } from "./dist/ops/telemetry.js";
import { createLogger } from "./dist/ops/logger.js";
import { telemetry as livekit } from "@livekit/agents";

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.cwd() !== "/app") {
  throw new Error("Run this check inside the configured SA2 agent container");
}
const handle = await getChildTelemetry(
  process.env.SERVICE_NAME,
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
);
// docker exec stdout isn't a container log; use the worker's stdout destination.
const destination = createWriteStream("/proc/1/fd/1");
const log = createLogger({ service: process.env.SERVICE_NAME }, destination);
const checkId = randomUUID();
let context;
try {
  await handle.withSpan(
    "telemetry.child_delivery_check",
    { synthetic: true, check_id: checkId },
    async () => {
      await livekit.tracer.startActiveSpan(
        async () => {
          context = getActiveTraceFields();
          log.info(
            { event: "telemetry_child_delivery_check", synthetic: true, check_id: checkId },
            "synthetic child telemetry delivery check",
          );
        },
        {
          name: "agent_session.synthetic_delivery_check",
          attributes: { synthetic: true, check_id: checkId },
        },
      );
    },
  );
  await handle.flush();
} finally {
  await handle.shutdown();
  await new Promise((done) => destination.end(done));
}
console.log(JSON.stringify({ check_id: checkId, ...context, synthetic: true }));
