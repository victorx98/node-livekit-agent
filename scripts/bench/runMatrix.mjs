// Experiment matrix for the Gemini latency investigation.
//
// Runs the bench harnesses through the suites that discriminate the latency
// hypotheses, then aggregates every run's summary.json into one report.
//
//   e1  utterance-length sweep, fresh session   -> does latency scale with
//       (5/15/30/60s, default thinking)            how long the user speaks?
//   e2  same sweep, thinkingBudget=0            -> if e1 growth disappears,
//                                                  thinking is the cause
//   e3  16x10s turns, compression on + off      -> does latency grow with
//                                                  session age / context size?
//   e4  resume test: replay vs handle-only      -> does the plugin's full
//                                                  history re-send double the
//                                                  server context on reconnect?
//   e5  production plugin path, 12x10s turns    -> do raw findings reproduce
//                                                  through the real code path?
//
// Usage:
//   node --env-file=.env scripts/bench/runMatrix.mjs --sample candidate.wav \
//     [--suites e1,e2,e3,e4,e5] [--instructions-file path]
//
// Each suite is one or more sequential Gemini Live sessions; the full matrix
// takes roughly 45-60 minutes of wall-clock audio time.

import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { toCsv } from "./lib/stats.mjs";

const { values: args } = parseArgs({
  options: {
    sample: { type: "string" },
    suites: { type: "string", default: "e1,e2,e3,e4,e5" },
    "instructions-file": { type: "string" },
  },
});

if (!args.sample) {
  console.error("Missing --sample <speech.wav>.");
  process.exit(1);
}

const passthrough = [
  "--sample",
  args.sample,
  ...(args["instructions-file"] ? ["--instructions-file", args["instructions-file"]] : []),
];

const SUITES = {
  e1: [["rawBench.mjs", "--speech-ms", "5000,15000,30000,60000", "--label", "e1-sweep"]],
  e2: [
    [
      "rawBench.mjs",
      "--speech-ms",
      "5000,15000,30000,60000",
      "--thinking-budget",
      "0",
      "--label",
      "e2-sweep-nothink",
    ],
  ],
  e3: [
    ["rawBench.mjs", "--turns", "16", "--speech-ms", "10000", "--label", "e3-growth-compressed"],
    [
      "rawBench.mjs",
      "--turns",
      "12",
      "--speech-ms",
      "10000",
      "--no-compression",
      "--label",
      "e3-growth-uncompressed",
    ],
  ],
  e4: [
    ["rawBench.mjs", "--turns", "6", "--speech-ms", "8000", "--resume-test", "replay", "--label", "e4-replay"],
    [
      "rawBench.mjs",
      "--turns",
      "6",
      "--speech-ms",
      "8000",
      "--resume-test",
      "handle-only",
      "--label",
      "e4-handle-only",
    ],
  ],
  e5: [["pluginBench.mjs", "--turns", "12", "--speech-ms", "10000", "--label", "e5-prod-path"]],
};

const requested = args.suites.split(",").map((s) => s.trim());
for (const s of requested) {
  if (!SUITES[s]) {
    console.error(`Unknown suite '${s}'. Available: ${Object.keys(SUITES).join(", ")}`);
    process.exit(1);
  }
}

function run(script, scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("scripts", "bench", script), ...scriptArgs, ...passthrough],
      { stdio: "inherit" },
    );
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} ${scriptArgs.join(" ")} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

const resultsDir = "bench-results";
const preexistingRuns = new Set(await readdir(resultsDir).catch(() => []));
const failures = [];
for (const suite of requested) {
  for (const cmd of SUITES[suite]) {
    const [script, ...scriptArgs] = cmd;
    console.log(`\n=== suite ${suite}: ${script} ${scriptArgs.join(" ")} ===\n`);
    try {
      await run(script, scriptArgs);
    } catch (err) {
      // Keep going: a failed scenario (quota, disconnect) should not lose the
      // rest of the matrix. The failure is reported in the final summary.
      console.error(`suite ${suite} scenario failed: ${err.message}`);
      failures.push({ suite, script, args: scriptArgs.join(" "), error: err.message });
    }
  }
}

// Aggregate the summary.json of every run this matrix produced.
const runDirs = (await readdir(resultsDir).catch(() => []))
  .filter((d) => !preexistingRuns.has(d))
  .sort();
const aggregated = [];
for (const d of runDirs) {
  try {
    const summary = JSON.parse(await readFile(path.join(resultsDir, d, "summary.json"), "utf8"));
    for (const row of summary.rows) {
      aggregated.push({
        run: d,
        kind: summary.config.kind,
        thinkingBudget: summary.config.thinkingBudget,
        compression: summary.config.compression,
        resumeTest: summary.config.resumeTest ?? "",
        ...row,
      });
    }
  } catch {
    // not a finished run dir
  }
}

const reportPath = path.join(resultsDir, "matrix-report.csv");
await writeFile(reportPath, toCsv(aggregated));
console.log(`\nMatrix complete. ${aggregated.length} turns aggregated -> ${reportPath}`);
if (failures.length) {
  console.log(`Failures (${failures.length}):`);
  for (const f of failures) console.log(`  - [${f.suite}] ${f.script} ${f.args}: ${f.error}`);
}
console.log("Per-run details: bench-results/<run>/summary.json, turns.csv, events.jsonl");
