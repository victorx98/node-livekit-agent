// Raw Gemini Live API latency bench.
//
// Connects directly via @google/genai (bypassing LiveKit entirely), streams a
// real speech sample padded to a target duration as a paced "microphone", and
// measures the wall-clock gap from end-of-speech to the first response audio
// chunk — the same gap the user perceives, minus WebRTC playout.
//
// Unlike the plugin path, this harness sees the FULL LiveServerMessage,
// including usageMetadata.thoughtsTokenCount (the plugin discards thoughts),
// so it can attribute latency to thinking vs context growth vs VAD.
//
// Usage:
//   node --env-file=.env scripts/bench/rawBench.mjs --sample candidate.wav \
//     [--turns 1] [--speech-ms 15000 | --speech-ms 5000,15000,30000,60000] \
//     [--thinking-budget 0] [--no-compression] [--trigger-tokens N] \
//     [--model id] [--voice Puck] [--silence-duration-ms 700] \
//     [--instructions-file path] [--resume-test replay|handle-only] \
//     [--max-wait-ms 120000] [--label name]
//
// Requires GOOGLE_API_KEY in the environment.

import { parseArgs } from "node:util";
import {
  ActivityHandling,
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
} from "@google/genai";
import { int16ToBase64, Pacer } from "./lib/audioPipe.mjs";
import {
  CHUNK_MS,
  createRunOutput,
  loadInstructions,
  loadSpeechSample,
  PROD_DEFAULTS,
  runTurnLoop,
  writeRunSummary,
} from "./lib/common.mjs";

const { values: args } = parseArgs({
  options: {
    sample: { type: "string" },
    turns: { type: "string", default: "1" },
    "speech-ms": { type: "string", default: "15000" },
    "thinking-budget": { type: "string" },
    "no-compression": { type: "boolean", default: false },
    "no-input-transcription": { type: "boolean", default: false },
    "trigger-tokens": { type: "string" },
    model: { type: "string", default: PROD_DEFAULTS.model },
    voice: { type: "string", default: PROD_DEFAULTS.voice },
    "silence-duration-ms": { type: "string", default: String(PROD_DEFAULTS.silenceDurationMs) },
    "instructions-file": { type: "string" },
    "resume-test": { type: "string" },
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
if (args["resume-test"] && !["replay", "handle-only"].includes(args["resume-test"])) {
  console.error("--resume-test must be 'replay' or 'handle-only'.");
  process.exit(1);
}

const speechMsList = args["speech-ms"].split(",").map((s) => Number(s.trim()));
const turns = speechMsList.length > 1 ? speechMsList.length : Number(args.turns);
const speechMsPerTurn = speechMsList.length > 1 ? speechMsList : speechMsList[0];
const maxWaitMs = Number(args["max-wait-ms"]);

const speech = loadSpeechSample(args.sample);
const instructions = loadInstructions(args);
const { dir, logEvent, close: closeLog } = createRunOutput("raw", args.label);
const log = (msg) => console.log(`[rawBench] ${msg}`);

const connectConfig = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: { parts: [{ text: instructions }] },
  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: args.voice } } },
  // Omitting inputAudioTranscription disables it; the bench's speech-end
  // ground truth and first_audio measurement do not depend on it.
  ...(args["no-input-transcription"] ? {} : { inputAudioTranscription: {} }),
  outputAudioTranscription: {},
  realtimeInputConfig: {
    automaticActivityDetection: {
      prefixPaddingMs: PROD_DEFAULTS.prefixPaddingMs,
      silenceDurationMs: Number(args["silence-duration-ms"]),
      startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
      endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
    },
    activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
  },
  sessionResumption: {},
  ...(args["no-compression"]
    ? {}
    : {
        contextWindowCompression: {
          slidingWindow: {},
          ...(args["trigger-tokens"] ? { triggerTokens: args["trigger-tokens"] } : {}),
        },
      }),
  ...(args["thinking-budget"] !== undefined
    ? { thinkingConfig: { thinkingBudget: Number(args["thinking-budget"]) } }
    : {}),
};

// --- per-turn event recording -------------------------------------------------

let turn = null; // open turn record, or null between turns
let turnEnded = null; // resolver for waitForTurnEnd
let resumptionHandle = null;
let sessionClosed = false;
const transcript = []; // [{role: 'user'|'model', text}] for --resume-test replay

function openTurn() {
  turn = { events: {}, userText: "", modelText: "", turnCompleteSeen: false, usageSeen: false };
}

// The server often delivers usageMetadata in a message AFTER turnComplete.
// Finish the turn only once both arrived, with a grace timer as fallback, so
// token columns are not silently null in turns.csv.
function maybeFinishTurn() {
  if (turn && turn.turnCompleteSeen && turn.usageSeen && turnEnded) {
    const done = turnEnded;
    turnEnded = null;
    done();
  }
}

function onServerMessage(message) {
  const now = Date.now();
  const sc = message.serverContent;

  if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
    resumptionHandle = message.sessionResumptionUpdate.newHandle;
    logEvent("session_resumption_update", {});
    return;
  }
  if (message.goAway) {
    logEvent("go_away", { timeLeft: message.goAway.timeLeft });
    log(`!! server goAway, timeLeft=${JSON.stringify(message.goAway.timeLeft)}`);
    return;
  }
  if (message.setupComplete) {
    logEvent("setup_complete", {});
    return;
  }
  if (message.usageMetadata) {
    logEvent("usage_metadata", { usage: message.usageMetadata });
    if (turn) {
      turn.events.usage = message.usageMetadata;
      turn.usageSeen = true;
      maybeFinishTurn();
    }
  }
  if (!sc) return;

  // Mirror the plugin's "generation starts on first serverContent" semantics
  // so rows are comparable with pluginBench.
  if (turn && turn.events.generationCreatedAt === undefined) {
    turn.events.generationCreatedAt = now;
  }
  if (sc.inputTranscription?.text) {
    if (turn) {
      turn.events.firstTranscriptionAt ??= now;
      turn.userText += sc.inputTranscription.text;
    }
    logEvent("input_transcription", { text: sc.inputTranscription.text });
  }
  if (sc.outputTranscription?.text) {
    if (turn) turn.modelText += sc.outputTranscription.text;
    logEvent("output_transcription", { text: sc.outputTranscription.text });
  }
  for (const part of sc.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) {
      const bytes = Buffer.from(part.inlineData.data, "base64").length;
      if (turn && turn.events.firstAudioAt === undefined) {
        turn.events.firstAudioAt = now;
        logEvent("first_audio", { bytes });
      } else {
        logEvent("audio_chunk", { bytes });
      }
    }
    if (part.thought) logEvent("thought_part", {});
    if (part.text) logEvent("text_part", { text: part.text });
  }
  if (sc.interrupted) logEvent("interrupted", {});
  if (sc.generationComplete) {
    if (turn) turn.events.generationCompleteAt = now;
    logEvent("generation_complete", {});
  }
  if (sc.turnComplete) {
    logEvent("turn_complete", {});
    if (turn) {
      turn.turnCompleteSeen = true;
      maybeFinishTurn();
      // Fallback: if usageMetadata never arrives (e.g. cancelled generation),
      // finish this turn after a grace window rather than waiting out maxWaitMs.
      const thisTurn = turn;
      setTimeout(() => {
        if (turn === thisTurn && turnEnded) {
          logEvent("usage_metadata_missing", {});
          const done = turnEnded;
          turnEnded = null;
          done();
        }
      }, 1500);
    }
  }
}

let connectEpoch = 0;

async function connect(ai, extra = {}) {
  // Each connection gets an epoch so a stale onclose (e.g. the pre-reconnect
  // session closing late during --resume-test) cannot mute the new session.
  const epoch = ++connectEpoch;
  let onOpen;
  const opened = new Promise((resolve) => {
    onOpen = resolve;
  });
  const session = await ai.live.connect({
    model: args.model,
    config: { ...connectConfig, ...extra },
    callbacks: {
      onopen: () => onOpen(),
      onmessage: onServerMessage,
      onerror: (e) => {
        logEvent("ws_error", { message: String(e?.message ?? e) });
        log(`!! websocket error: ${e?.message ?? e}`);
      },
      onclose: (e) => {
        if (epoch !== connectEpoch) return; // a newer connection is active
        sessionClosed = true;
        logEvent("ws_close", { code: e?.code, reason: e?.reason });
        if (e?.code !== 1000) log(`!! websocket closed: ${e?.code} ${e?.reason ?? ""}`);
        // A dead socket means no further server events: end any pending turn
        // now instead of waiting out the turn timeout.
        if (turnEnded) {
          const done = turnEnded;
          turnEnded = null;
          done();
        }
      },
    },
  });
  await opened;
  sessionClosed = false;
  return session;
}

// --- main ----------------------------------------------------------------------

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
log(`connecting model=${args.model} compression=${!args["no-compression"]} thinkingBudget=${args["thinking-budget"] ?? "default"}`);
let session = await connect(ai);

let pacer = new Pacer({
  chunkMs: CHUNK_MS,
  onChunk: (samples) => {
    if (sessionClosed) return;
    session.sendRealtimeInput({
      audio: { data: int16ToBase64(samples), mimeType: "audio/pcm;rate=16000" },
    });
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
    // On a dead socket no server events will ever arrive; don't wait out maxWaitMs.
    const waitMs = sessionClosed ? 0 : maxWaitMs;
    timer = setTimeout(() => {
      if (turnEnded) {
        turnEnded = null;
        logEvent("turn_timeout", { sessionClosed });
        if (!sessionClosed) log(`!! turn timed out after ${maxWaitMs}ms without turnComplete`);
        resolve();
      }
    }, waitMs);
  });
  // Clear the watchdog even when the turn ended normally: a stale timer would
  // otherwise fire mid-way through a LATER turn and cut it short.
  clearTimeout(timer);
  const events = turn.events;
  if (turn.userText) transcript.push({ role: "user", text: turn.userText });
  if (turn.modelText) transcript.push({ role: "model", text: turn.modelText });
  turn = null;
  return events;
};

const notes = [];
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

  if (args["resume-test"]) {
    log(`resume test (${args["resume-test"]}): closing session and reconnecting...`);
    if (!resumptionHandle) {
      notes.push("resume_test_skipped: no resumption handle was received before reconnect");
      log("!! no resumption handle received; cannot run resume test");
    } else {
      await pacer.stop();
      session.close();
      logEvent("forced_reconnect", { mode: args["resume-test"] });

      session = await connect(ai, { sessionResumption: { handle: resumptionHandle } });
      if (args["resume-test"] === "replay") {
        // Mimic @livekit/agents-plugin-google realtime_api.ts #mainTask, which
        // re-sends the full accumulated history on every reconnect even when a
        // resumption handle restores server-side state.
        session.sendClientContent({
          turns: transcript.map(({ role, text }) => ({ role, parts: [{ text }] })),
          turnComplete: false,
        });
        logEvent("history_replayed", { turns: transcript.length });
      }
      pacer = new Pacer({
        chunkMs: CHUNK_MS,
        onChunk: (samples) => {
          if (sessionClosed) return;
          session.sendRealtimeInput({
            audio: { data: int16ToBase64(samples), mimeType: "audio/pcm;rate=16000" },
          });
        },
      });
      pacer.start();

      const postRows = await runTurnLoop({
        turns: 1,
        speechMsPerTurn: Array.isArray(speechMsPerTurn) ? speechMsPerTurn[0] : speechMsPerTurn,
        speech,
        speakTurn,
        waitForTurnEnd,
        log,
        maxWaitMs,
      });
      postRows[0].turnIndex = rows.length;
      postRows[0].postReconnect = true;
      rows.push(postRows[0]);

      const pre = rows[rows.length - 2]?.promptTokens;
      const post = postRows[0].promptTokens;
      notes.push(
        `resume_test mode=${args["resume-test"]} promptTokens before reconnect=${pre} after=${post}`,
      );
      log(`resume test: promptTokens ${pre} -> ${post}`);
    }
  }
} finally {
  await pacer.stop();
  try {
    session.close();
  } catch {
    // already closed
  }
  await closeLog();
  const summary = await writeRunSummary(dir, {
    config: {
      kind: "raw",
      model: args.model,
      speechMsPerTurn,
      turns,
      compression: !args["no-compression"],
      triggerTokens: args["trigger-tokens"] ?? null,
      thinkingBudget: args["thinking-budget"] ?? "default",
      silenceDurationMs: Number(args["silence-duration-ms"]),
      voice: args.voice,
      resumeTest: args["resume-test"] ?? null,
      inputTranscription: !args["no-input-transcription"],
      instructionsChars: instructions.length,
    },
    rows,
    notes,
  });
  log(`results written to ${dir}`);
  log(
    `trend: ${summary.trends.msPerSpeechSecond?.toFixed?.(0) ?? "n/a"} ms added per speech second; ` +
      `${summary.trends.msPerTurn?.toFixed?.(0) ?? "n/a"} ms added per turn`,
  );
}
