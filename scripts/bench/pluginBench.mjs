// Production-path Gemini latency bench.
//
// Drives the exact code path the interview agent uses — the installed
// @livekit/agents-plugin-google RealtimeModel/RealtimeSession with the app's
// own config builders (imported from dist/providers/google.js) — but replaces
// the LiveKit room with a paced PCM feed, so end-of-speech -> first-audio can
// be measured without WebRTC. Comparing these rows against rawBench.mjs rows
// isolates plugin overhead from Gemini server behavior.
//
// The plugin's own ttftMs metric is recorded alongside (column pluginTtftMs):
// it starts counting mid-user-speech, so the difference between it and
// eouToFirstAudioMs demonstrates the measurement artifact documented in the
// audit.
//
// Usage:
//   pnpm build   # dist/providers/google.js supplies the prod config builders
//   node --env-file=.env scripts/bench/pluginBench.mjs --sample candidate.wav \
//     [--turns 12] [--speech-ms 10000] [--thinking-budget 0] \
//     [--no-compression] [--instructions-file path] [--label name]
//
// Requires GOOGLE_API_KEY. Set LK_GOOGLE_DEBUG=1 for full wire-level logs.

import { parseArgs } from "node:util";
import { AudioFrame } from "@livekit/rtc-node";
import { initializeLogger } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";

// The plugin's RealtimeSession uses the agents framework logger, which throws
// unless initialized (normally done by the worker CLI).
initializeLogger({ pretty: true, level: process.env.LK_GOOGLE_DEBUG ? "debug" : "warn" });
import { Pacer } from "./lib/audioPipe.mjs";
import {
  CHUNK_MS,
  createRunOutput,
  loadInstructions,
  loadSpeechSample,
  PROD_DEFAULTS,
  runTurnLoop,
  TARGET_SAMPLE_RATE,
  writeRunSummary,
} from "./lib/common.mjs";

const { values: args } = parseArgs({
  options: {
    sample: { type: "string" },
    turns: { type: "string", default: "1" },
    "speech-ms": { type: "string", default: "15000" },
    "thinking-budget": { type: "string" },
    "no-compression": { type: "boolean", default: false },
    model: { type: "string", default: PROD_DEFAULTS.model },
    voice: { type: "string", default: PROD_DEFAULTS.voice },
    "silence-duration-ms": { type: "string", default: String(PROD_DEFAULTS.silenceDurationMs) },
    "instructions-file": { type: "string" },
    "max-wait-ms": { type: "string", default: "120000" },
    label: { type: "string", default: "run" },
  },
});

if (!args.sample) {
  console.error("Missing --sample <speech.wav> (16-bit PCM WAV of real speech).");
  process.exit(1);
}
if (!process.env.GOOGLE_API_KEY) {
  console.error("Missing GOOGLE_API_KEY in environment (use node --env-file=.env).");
  process.exit(1);
}

// Use the app's real config builders so the bench cannot drift from production.
let buildGeminiRealtimeInputConfig;
let buildGeminiContextWindowCompression;
try {
  ({ buildGeminiRealtimeInputConfig, buildGeminiContextWindowCompression } = await import(
    "../../dist/providers/google.js"
  ));
} catch {
  console.error("dist/providers/google.js not found — run `pnpm build` first.");
  process.exit(1);
}

const speechMsList = args["speech-ms"].split(",").map((s) => Number(s.trim()));
const turns = speechMsList.length > 1 ? speechMsList.length : Number(args.turns);
const speechMsPerTurn = speechMsList.length > 1 ? speechMsList : speechMsList[0];
const maxWaitMs = Number(args["max-wait-ms"]);

const speech = loadSpeechSample(args.sample);
const instructions = loadInstructions(args);
const { dir, logEvent, close: closeLog } = createRunOutput("plugin", args.label);
const log = (msg) => console.log(`[pluginBench] ${msg}`);

const model = new google.realtime.RealtimeModel({
  model: args.model,
  apiKey: process.env.GOOGLE_API_KEY,
  voice: args.voice,
  instructions,
  realtimeInputConfig: buildGeminiRealtimeInputConfig(
    {
      silence_duration_ms: Number(args["silence-duration-ms"]),
      interrupt_response: true,
    },
    args.model,
  ),
  contextWindowCompression: buildGeminiContextWindowCompression({
    geminiContextWindowCompressionEnabled: !args["no-compression"],
    geminiContextWindowCompressionTriggerTokens: undefined,
  }),
  ...(args["thinking-budget"] !== undefined
    ? { thinkingConfig: { thinkingBudget: Number(args["thinking-budget"]) } }
    : {}),
});

const session = model.session();

// --- per-turn event recording -------------------------------------------------

let turn = null;
let turnEnded = null;

function openTurn() {
  turn = { events: {}, metricsReceived: false, generationDone: false };
}

function maybeFinishTurn() {
  // The turn is complete once the generation's streams closed AND the usage
  // metrics arrived (metrics fire just before stream close; require both to
  // avoid racing the slower one).
  if (turn && turn.metricsReceived && turn.generationDone && turnEnded) {
    const done = turnEnded;
    turnEnded = null;
    done();
  }
}

session.on("generation_created", (ev) => {
  const now = Date.now();
  logEvent("generation_created", { responseId: ev.responseId, userInitiated: ev.userInitiated });
  if (!turn) return;
  turn.events.generationCreatedAt ??= now;

  void (async () => {
    const reader = ev.messageStream.getReader();
    const drains = [];
    while (true) {
      const { done, value: msg } = await reader.read();
      if (done) break;
      drains.push(
        (async () => {
          const audioReader = msg.audioStream.getReader();
          let frames = 0;
          while (true) {
            const { done: audioDone } = await audioReader.read();
            if (audioDone) break;
            if (turn && turn.events.firstAudioAt === undefined) {
              turn.events.firstAudioAt = Date.now();
              logEvent("first_audio", {});
            }
            frames += 1;
          }
          logEvent("audio_stream_closed", { frames });
        })(),
        (async () => {
          const textReader = msg.textStream.getReader();
          while (!(await textReader.read()).done) {
            // drain; transcript content is visible in events.jsonl via the
            // input_audio_transcription_completed events instead
          }
        })(),
      );
    }
    await Promise.all(drains);
    if (turn) {
      turn.events.generationCompleteAt = Date.now();
      turn.generationDone = true;
      maybeFinishTurn();
      // Fallback: the plugin only emits metrics_collected when usageMetadata
      // reaches an active generation; an interrupted generation may never get
      // one. Finish after a grace window instead of waiting out maxWaitMs.
      const thisTurn = turn;
      setTimeout(() => {
        if (turn === thisTurn && !turn.metricsReceived) {
          logEvent("metrics_missing", {});
          turn.metricsReceived = true;
          maybeFinishTurn();
        }
      }, 3000);
    }
  })();
});

session.on("input_audio_transcription_completed", (ev) => {
  if (turn) turn.events.firstTranscriptionAt ??= Date.now();
  logEvent("input_transcription", { isFinal: ev.isFinal, chars: ev.transcript.length });
});

session.on("metrics_collected", (m) => {
  logEvent("metrics_collected", { metrics: m });
  if (!turn) return;
  turn.events.usage = {
    promptTokenCount: m.inputTokens,
    responseTokenCount: m.outputTokens,
    totalTokenCount: m.totalTokens,
    cachedContentTokenCount: m.inputTokenDetails?.cachedTokens,
  };
  turn.pluginTtftMs = m.ttftMs;
  turn.metricsReceived = true;
  maybeFinishTurn();
});

session.on("error", (ev) => {
  logEvent("session_error", { message: String(ev.error?.message ?? ev.error) });
  log(`!! session error: ${ev.error?.message ?? ev.error}`);
});

// --- main ----------------------------------------------------------------------

log(`starting model=${args.model} compression=${!args["no-compression"]} thinkingBudget=${args["thinking-budget"] ?? "default"}`);

const pacer = new Pacer({
  chunkMs: CHUNK_MS,
  onChunk: (samples) => {
    // Copy: the plugin's pushAudio sends frame.data.buffer (the WHOLE backing
    // ArrayBuffer), so a subarray view would leak the entire utterance into
    // every 50ms chunk. rtc-node room frames own their buffers, so production
    // is unaffected — but bench chunks are views.
    const owned = new Int16Array(samples.length);
    owned.set(samples);
    session.pushAudio(new AudioFrame(owned, TARGET_SAMPLE_RATE, 1, owned.length));
  },
});
pacer.start();

const speakTurn = async (utterance) => {
  openTurn();
  return pacer.enqueueUtterance(utterance);
};

const waitForTurnEnd = async () => {
  let timer;
  await new Promise((resolve) => {
    turnEnded = resolve;
    timer = setTimeout(() => {
      if (turnEnded) {
        turnEnded = null;
        logEvent("turn_timeout", {});
        log(`!! turn timed out after ${maxWaitMs}ms`);
        resolve();
      }
    }, maxWaitMs);
  });
  // Clear the watchdog even when the turn ended normally: a stale timer would
  // otherwise fire mid-way through a LATER turn and cut it short.
  clearTimeout(timer);
  const events = turn.events;
  const pluginTtftMs = turn.pluginTtftMs;
  turn = null;
  return { ...events, pluginTtftMs };
};

let rows = [];
try {
  rows = await runTurnLoop({
    turns,
    speechMsPerTurn,
    speech,
    speakTurn,
    waitForTurnEnd,
    log,
    maxWaitMs,
  });
} finally {
  await pacer.stop();
  await session.close().catch(() => {});
  await model.close().catch(() => {});
  await closeLog();
  const summary = await writeRunSummary(dir, {
    config: {
      kind: "plugin",
      model: args.model,
      speechMsPerTurn,
      turns,
      compression: !args["no-compression"],
      thinkingBudget: args["thinking-budget"] ?? "default",
      silenceDurationMs: Number(args["silence-duration-ms"]),
      voice: args.voice,
      instructionsChars: instructions.length,
    },
    rows,
    notes: [],
  });
  log(`results written to ${dir}`);
  log(
    `trend: ${summary.trends.msPerSpeechSecond?.toFixed?.(0) ?? "n/a"} ms added per speech second; ` +
      `${summary.trends.msPerTurn?.toFixed?.(0) ?? "n/a"} ms added per turn`,
  );
  process.exit(0); // the plugin keeps internal timers alive; exit explicitly
}
