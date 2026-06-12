// Per-turn latency summarization and reporting for the Gemini bench.
// Pure functions, no I/O — tested in stats.test.mjs.

/**
 * Reduce one turn's raw event timestamps (epoch ms) into latency gaps.
 *
 * speechEndAt is ground truth: the wall-clock time the last speech-bearing
 * audio chunk was handed to the websocket. eouToFirstAudioMs is the
 * user-perceived response time (minus client playout, which the bench
 * does not model).
 */
export function summarizeTurn(turn) {
  const anomalies = [];
  const gap = (from, to) => (from !== undefined && to !== undefined ? to - from : null);

  const eouToFirstAudioMs = gap(turn.speechEndAt, turn.firstAudioAt);
  const eouToGenerationMs = gap(turn.speechEndAt, turn.generationCreatedAt);
  const generationToFirstAudioMs = gap(turn.generationCreatedAt, turn.firstAudioAt);
  const eouToFirstTranscriptionMs = gap(turn.speechEndAt, turn.firstTranscriptionAt);
  const responseDurationMs = gap(turn.firstAudioAt, turn.generationCompleteAt);

  if (turn.firstAudioAt === undefined) anomalies.push("no_audio_response");
  if (eouToFirstAudioMs !== null && eouToFirstAudioMs < 0) {
    anomalies.push("audio_before_end_of_speech");
  }

  const usage = turn.usage ?? {};
  const orNull = (v) => (v === undefined ? null : v);

  return {
    turnIndex: turn.turnIndex,
    speechMs: turn.speechMs,
    eouToFirstAudioMs,
    eouToGenerationMs,
    generationToFirstAudioMs,
    eouToFirstTranscriptionMs,
    responseDurationMs,
    promptTokens: orNull(usage.promptTokenCount),
    responseTokens: orNull(usage.responseTokenCount),
    thoughtsTokens: orNull(usage.thoughtsTokenCount),
    totalTokens: orNull(usage.totalTokenCount),
    cachedTokens: orNull(usage.cachedContentTokenCount),
    // Plugin-reported TTFT (starts mid-user-speech); kept alongside the real
    // gap to make the measurement artifact visible in one row.
    ...(turn.pluginTtftMs !== undefined ? { pluginTtftMs: turn.pluginTtftMs } : {}),
    anomalies,
  };
}

/** Least-squares linear fit. Returns { slope: null } for fewer than two points. */
export function linearTrend(points) {
  const n = points.length;
  if (n < 2) return { slope: null, intercept: null, n };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const { x, y } of points) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: null, intercept: null, n };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n, n };
}

/**
 * Render rows as CSV. Column order is the given list, or the union of row
 * keys in first-seen order. null/undefined render as empty cells.
 */
export function toCsv(rows, columns) {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v) ? v.join(";") : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const row of rows) lines.push(cols.map((c) => cell(row[c])).join(","));
  return lines.join("\n");
}
