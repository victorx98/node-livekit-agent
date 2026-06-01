import { describe, it, expect } from "vitest";
import { chatRoleToTranscriptRole } from "./transcriptStore.js";

describe("chatRoleToTranscriptRole (§14)", () => {
  it.each([
    ["assistant", "interviewer"],
    ["user", "candidate"],
    ["system", "system"],
    ["developer", "system"],
    ["something-else", "system"],
  ])("maps chat role %s -> transcript role %s", (input, expected) => {
    expect(chatRoleToTranscriptRole(input)).toBe(expected);
  });
});
