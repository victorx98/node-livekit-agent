import { describe, expect, it, vi } from "vitest";
import { loadRecoverySource, type RecoveryContextReader } from "./recoverySource.js";
import type { InterviewRecoverySnapshot } from "../types/config.js";

const fallbackSnapshot: InterviewRecoverySnapshot = {
  system_instruction: "fallback instruction",
  questions: [],
  language: "English",
  interview_type: "technical",
  position: "Engineer",
  company: "",
  duration_minutes: 30,
  candidate: { name: "Candidate" },
};
const fallbackTranscript = [
  { role: "candidate" as const, text: "fallback answer", at: "2026-06-01T10:00:00.000Z" },
];

function reader(overrides: Partial<RecoveryContextReader> = {}): RecoveryContextReader {
  return {
    getRecoverySnapshot: vi.fn(async () => undefined),
    getTranscript: vi.fn(async () => []),
    ...overrides,
  };
}

describe("loadRecoverySource", () => {
  it("uses persisted snapshot and transcript when available", async () => {
    const persistedSnapshot = {
      ...fallbackSnapshot,
      system_instruction: "persisted instruction",
    };
    const persistedTranscript = [
      {
        jobId: "job_1",
        interviewId: "int_1",
        room: "room_1",
        role: "interviewer" as const,
        text: "persisted question",
        at: "2026-06-01T10:01:00.000Z",
        sequence: 1,
      },
    ];

    const result = await loadRecoverySource({
      jobId: "job_1",
      reader: reader({
        getRecoverySnapshot: vi.fn(async () => persistedSnapshot),
        getTranscript: vi.fn(async () => persistedTranscript),
      }),
      fallbackSnapshot,
      fallbackTranscript,
    });

    expect(result).toMatchObject({
      snapshot: persistedSnapshot,
      transcript: persistedTranscript,
      degraded: false,
    });
  });

  it("uses the in-memory transcript when Redis has no transcript yet", async () => {
    const result = await loadRecoverySource({
      jobId: "job_1",
      reader: reader(),
      fallbackSnapshot,
      fallbackTranscript,
    });

    expect(result.transcript).toEqual(fallbackTranscript);
    expect(result.degraded).toBe(false);
  });

  it("falls back to in-memory recovery material when a read fails", async () => {
    const error = new Error("redis unavailable");
    const result = await loadRecoverySource({
      jobId: "job_1",
      reader: reader({
        getRecoverySnapshot: vi.fn(async () => {
          throw error;
        }),
      }),
      fallbackSnapshot,
      fallbackTranscript,
    });

    expect(result).toEqual({
      snapshot: fallbackSnapshot,
      transcript: fallbackTranscript,
      degraded: true,
      error,
    });
  });
});
