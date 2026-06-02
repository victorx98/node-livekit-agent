import { describe, it, expect } from "vitest";
import { preflightObjectKey } from "./s3Preflight.js";

describe("preflightObjectKey (§16)", () => {
  it("writes the probe next to the recording key so it shares the same prefix permissions", () => {
    expect(preflightObjectKey("interviews/int_789/job_123.mp4")).toBe(
      "interviews/int_789/job_123.mp4.preflight",
    );
  });
});
