import { describe, expect, it } from "vitest";
import { linearTrend, summarizeTurn, toCsv } from "./stats.mjs";

describe("summarizeTurn", () => {
  const base = {
    turnIndex: 3,
    speechMs: 15000,
    speechEndAt: 100_000,
    firstTranscriptionAt: 92_000,
    generationCreatedAt: 92_100,
    firstAudioAt: 103_500,
    generationCompleteAt: 110_000,
    usage: {
      promptTokenCount: 4200,
      responseTokenCount: 310,
      totalTokenCount: 4600,
      thoughtsTokenCount: 90,
    },
  };

  it("computes the user-perceived gap and component gaps", () => {
    const row = summarizeTurn(base);
    expect(row.turnIndex).toBe(3);
    expect(row.speechMs).toBe(15000);
    expect(row.eouToFirstAudioMs).toBe(3500); // 103500 - 100000
    expect(row.generationToFirstAudioMs).toBe(11400); // 103500 - 92100
    expect(row.promptTokens).toBe(4200);
    expect(row.thoughtsTokens).toBe(90);
    expect(row.anomalies).toEqual([]);
  });

  it("yields null gaps when no audio ever arrived", () => {
    const row = summarizeTurn({ ...base, firstAudioAt: undefined, generationCompleteAt: undefined });
    expect(row.eouToFirstAudioMs).toBeNull();
    expect(row.generationToFirstAudioMs).toBeNull();
    expect(row.anomalies).toContain("no_audio_response");
  });

  it("flags negative gaps (audio before end of speech) as anomalies but preserves the value", () => {
    const row = summarizeTurn({ ...base, firstAudioAt: 99_000 });
    expect(row.eouToFirstAudioMs).toBe(-1000);
    expect(row.anomalies).toContain("audio_before_end_of_speech");
  });

  it("tolerates missing usage metadata", () => {
    const row = summarizeTurn({ ...base, usage: undefined });
    expect(row.promptTokens).toBeNull();
    expect(row.thoughtsTokens).toBeNull();
  });

  it("passes a harness-supplied pluginTtftMs through to the row", () => {
    expect(summarizeTurn({ ...base, pluginTtftMs: 17000 }).pluginTtftMs).toBe(17000);
    expect(summarizeTurn(base).pluginTtftMs).toBeUndefined();
  });
});

describe("linearTrend", () => {
  it("returns the exact slope for two points", () => {
    const t = linearTrend([
      { x: 1, y: 10 },
      { x: 3, y: 20 },
    ]);
    expect(t.slope).toBeCloseTo(5);
    expect(t.intercept).toBeCloseTo(5);
    expect(t.n).toBe(2);
  });

  it("fits a least-squares slope over noisy points", () => {
    const points = [0, 1, 2, 3, 4].map((x) => ({ x, y: 100 + 50 * x }));
    const t = linearTrend(points);
    expect(t.slope).toBeCloseTo(50);
    expect(t.intercept).toBeCloseTo(100);
  });

  it("returns null slope for fewer than two points", () => {
    expect(linearTrend([{ x: 1, y: 1 }]).slope).toBeNull();
    expect(linearTrend([]).slope).toBeNull();
  });
});

describe("toCsv", () => {
  it("renders rows with a stable header order", () => {
    const csv = toCsv(
      [
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ],
      ["a", "b"],
    );
    expect(csv).toBe("a,b\n1,x\n2,y");
  });

  it("escapes commas, quotes and newlines", () => {
    const csv = toCsv([{ a: 'say "hi", twice', b: "line1\nline2" }], ["a", "b"]);
    expect(csv).toBe('a,b\n"say ""hi"", twice","line1\nline2"');
  });

  it("renders null/undefined as empty cells", () => {
    const csv = toCsv([{ a: null, b: undefined, c: 0 }], ["a", "b", "c"]);
    expect(csv).toBe("a,b,c\n,,0");
  });

  it("derives columns from the union of row keys when not given", () => {
    const csv = toCsv([{ a: 1 }, { b: 2 }]);
    expect(csv).toBe("a,b\n1,\n,2");
  });
});
