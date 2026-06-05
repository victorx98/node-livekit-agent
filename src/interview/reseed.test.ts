import { describe, expect, it } from "vitest";
import {
  buildRecoveryChatContext,
  buildSessionSeed,
  selectRecoveryTurns,
  type RecoveryTranscriptTurn,
} from "./reseed.js";

const NOW = "2026-06-01T10:00:00.000Z";
const limits = { maxTurns: 24, maxChars: 24_000 };

function turn(
  role: RecoveryTranscriptTurn["role"],
  text: string,
  offsetSeconds = 0,
): RecoveryTranscriptTurn {
  return {
    role,
    text,
    at: new Date(Date.parse(NOW) + offsetSeconds * 1000).toISOString(),
  };
}

function messages(chatCtx: ReturnType<typeof buildRecoveryChatContext>) {
  return chatCtx.items
    .filter((item) => item.type === "message")
    .map((item) => ({ role: item.role, text: item.textContent }));
}

describe("fresh-session recovery context", () => {
  it("uses the API instruction unchanged and no chat context on first startup", () => {
    const instruction = "\n  exact API instruction  \n";
    const seed = buildSessionSeed(instruction, [turn("candidate", "ignored")], false, limits);

    expect(seed.instructions).toBe(instruction);
    expect(seed.recovered).toBe(false);
    expect(seed.chatCtx).toBeUndefined();
  });

  it("restores candidate and interviewer turns with correct LiveKit roles", () => {
    const transcript = [
      turn("interviewer", "First question", 1),
      turn("candidate", "First answer", 2),
      turn("system", "internal event", 3),
      turn("interviewer", "Follow-up", 4),
    ];
    const seed = buildSessionSeed("API INSTRUCTION", transcript, true, limits);

    expect(seed.instructions).toBe("API INSTRUCTION");
    expect(seed.recovered).toBe(true);
    expect(messages(seed.chatCtx!)).toEqual([
      { role: "assistant", text: "First question" },
      { role: "user", text: "First answer" },
      { role: "assistant", text: "Follow-up" },
    ]);
  });

  it("keeps the newest turns within the turn limit and preserves chronology", () => {
    const transcript = [
      turn("candidate", "one", 1),
      turn("interviewer", "two", 2),
      turn("candidate", "three", 3),
      turn("interviewer", "four", 4),
    ];

    expect(selectRecoveryTurns(transcript, { maxTurns: 2, maxChars: 100 })).toEqual([
      transcript[2],
      transcript[3],
    ]);
  });

  it("keeps restored text within the character limit", () => {
    const selected = selectRecoveryTurns(
      [turn("candidate", "older"), turn("interviewer", "1234567890")],
      { maxTurns: 10, maxChars: 6 },
    );

    expect(selected).toEqual([turn("interviewer", "123456")]);
    expect(selected.reduce((sum, item) => sum + item.text.length, 0)).toBe(6);
  });

  it("does not insert the system instruction or reconstructed questions into chat history", () => {
    const chatCtx = buildRecoveryChatContext([turn("candidate", "My actual answer")], limits);
    const serialized = JSON.stringify(messages(chatCtx));

    expect(serialized).toContain("My actual answer");
    expect(serialized).not.toContain("API INSTRUCTION");
    expect(serialized).not.toContain("question_text");
  });
});
