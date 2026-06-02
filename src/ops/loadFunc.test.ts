import { describe, it, expect } from "vitest";
import { computeLoad, loadThresholdFor, makeLoadFunc } from "./loadFunc.js";

describe("computeLoad (§18 per-worker cap)", () => {
  it("is 0 when idle, 0.5 at half capacity, and 1 at the cap", () => {
    expect(computeLoad(0, 8)).toBe(0);
    expect(computeLoad(4, 8)).toBe(0.5);
    expect(computeLoad(8, 8)).toBe(1);
  });

  it("clamps to 1 if active somehow exceeds the cap", () => {
    expect(computeLoad(12, 8)).toBe(1);
  });

  it("rejects a non-positive cap as a configuration error", () => {
    expect(() => computeLoad(0, 0)).toThrow(/cap/i);
    expect(() => computeLoad(1, -3)).toThrow(/cap/i);
  });
});

describe("loadThresholdFor (§18)", () => {
  it("falls strictly between the load at cap-1 and the load at the cap", () => {
    for (const max of [1, 5, 8, 20]) {
      const threshold = loadThresholdFor(max);
      // The framework marks a worker unavailable when load EXCEEDS the threshold,
      // so we want: full exactly at the cap, available at one below it.
      expect(computeLoad(max, max)).toBeGreaterThan(threshold);
      if (max > 1) expect(computeLoad(max - 1, max)).toBeLessThanOrEqual(threshold);
    }
  });
});

describe("makeLoadFunc (§18)", () => {
  it("derives load from the server's active job count", async () => {
    const loadFunc = makeLoadFunc(8);
    expect(await loadFunc({ activeJobs: new Array(2) } as never)).toBe(0.25);
    expect(await loadFunc({ activeJobs: new Array(8) } as never)).toBe(1);
  });

  it("treats a missing activeJobs list as zero load", async () => {
    const loadFunc = makeLoadFunc(8);
    expect(await loadFunc({} as never)).toBe(0);
  });
});
