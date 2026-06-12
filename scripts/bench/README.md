# Gemini Live latency bench

A test pipeline for the observed symptom: *Gemini response time (end of user
speech → first audible reply) reaches 5–15s+ and grows the longer the user
speaks, while OpenAI stays at 1–2s.*

Two harnesses stream a real speech sample as a paced live microphone
(50ms PCM16 chunks at 16kHz, continuous silence between utterances, exactly
like production) and measure the wall-clock gap from the last speech chunk to
the first response-audio chunk:

| Harness | Path | What it adds |
|---|---|---|
| `rawBench.mjs` | `@google/genai` Live API directly | full `usageMetadata` incl. `thoughtsTokenCount` (the plugin discards thoughts), forced-reconnect resume tests |
| `pluginBench.mjs` | the production path: installed `@livekit/agents-plugin-google` `RealtimeModel` + the app's own config builders from `dist/` | proves findings reproduce through the real code path; records the plugin's misleading `ttftMs` alongside the real gap |

## Setup

1. `GOOGLE_API_KEY` in `.env` (Vertex auth is not supported by the bench).
2. A WAV of real speech (16-bit PCM, any common sample rate, ≥5s — it is
   looped with sub-VAD-threshold gaps to build longer utterances). Real speech
   is required: Gemini's server-side VAD must detect it.
3. Optional but recommended: the production system instruction in a file
   (`--instructions-file`); it is logged per job as `instruction_text`.
4. For `pluginBench.mjs`: run `pnpm build` first.

## Run the whole matrix (~45–60 min)

```bash
node --env-file=.env scripts/bench/runMatrix.mjs --sample candidate.wav \
  --instructions-file instruction.txt
```

Or individual suites: `--suites e1,e2` (see header of `runMatrix.mjs`).

## How to read the results

Each run writes `bench-results/<stamp>-<kind>-<label>/` with `events.jsonl`
(every server event, timestamped), `turns.csv`, and `summary.json` (config,
per-turn rows, latency trends). The matrix additionally writes
`bench-results/matrix-report.csv` with all turns combined.

Key columns: `eouToFirstAudioMs` is the user-perceived response time.
`promptTokens` / `thoughtsTokens` / `cachedTokens` attribute where time goes.
`pluginTtftMs` (plugin runs only) is the plugin's own metric, which starts
counting mid-user-speech.

Hypothesis verdicts:

- **Thinking**: e1 shows `eouToFirstAudioMs` growing with `speechMs` while e2
  (thinkingBudget=0) stays flat → server thinking time is the driver. Check
  `thoughtsTokens` correlating with the gap. Fix: wire `thinking_level` into a
  `thinkingConfig` in `src/providers/google.ts`.
- **Context growth**: e3 shows the gap and `promptTokens` climbing
  turn-over-turn → prefill cost is the driver; compare compressed vs
  uncompressed slopes (`summary.json` → `trends.msPerTurn`).
- **Reconnect duplication**: e4 `replay` shows a `promptTokens` jump after the
  forced reconnect that `handle-only` does not → the plugin's unconditional
  history re-send (realtime_api.ts `#mainTask`) duplicates server context; an
  upstream issue/patch is warranted.
- **Plugin/framework overhead**: e5 gaps materially larger than raw runs with
  the same shape → client-side cause; inspect `events.jsonl` ordering and
  rerun with `LK_GOOGLE_DEBUG=1`.
