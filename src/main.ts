// Worker launcher. Runs the LiveKit Agents CLI (subcommands: dev | start |
// connect --room <name>) and points it at the agent job module (agent.ts).
//
// Two-file split on purpose: cli.runApp executes only in this parent process,
// while LiveKit's job subprocesses import agent.js (default export only), so
// runApp never re-runs in a child.
//
// Run with .env loaded, e.g.:  node --env-file=.env dist/main.js dev

import { cli, WorkerOptions } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { logger } from "./ops/logger.js";

const env = loadEnv();
const agentName = process.env.AGENT_NAME ?? "interview-agent";
const agentPath = fileURLToPath(new URL("./agent.js", import.meta.url));

logger.info(
  { event: "worker_starting", phase: "phase-1-walking-skeleton", agentName },
  "starting LiveKit interview agent worker",
);

cli.runApp(
  new WorkerOptions({
    agent: agentPath,
    // Explicit dispatch: jobs arrive only via AgentDispatchClient targeting this
    // agentName, which lets us attach per-interview metadata (see scripts/dispatch.mjs).
    agentName,
    numIdleProcesses: env.numIdleProcesses,
  }),
);
