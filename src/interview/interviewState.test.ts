import { describe, it, expect } from "vitest";
import {
  createInitialState,
  appendTurn,
  RECENT_TURNS_LIMIT,
  type InterviewState,
} from "./interviewState.js";

const NOW = "2026-06-01T10:00:00.000Z";

function initial(questionCount = 3): InterviewState {
  return createInitialState({
    jobId: "job_1",
    interviewId: "int_1",
    questionCount,
    now: NOW,
  });
}

describe("createInitialState (§13)", () => {
  it("starts at question 0 with all topics unanswered and empty turns", () => {
    const s = initial(3);
    expect(s.jobId).toBe("job_1");
    expect(s.interviewId).toBe("int_1");
    expect(s.currentQuestionIndex).toBe(0);
    expect(s.askedQuestionIds).toEqual([]);
    expect(s.unansweredTopics).toEqual([0, 1, 2]);
    expect(s.notes).toEqual([]);
    expect(s.recentTurns).toEqual([]);
    expect(s.stats).toEqual({
      turns: 0,
      reconnects: 0,
      startedAt: NOW,
      lastActivityAt: NOW,
    });
  });

  it("has no unanswered topics when there are no planned questions", () => {
    expect(initial(0).unansweredTopics).toEqual([]);
  });
});

describe("appendTurn (§13)", () => {
  it("records the turn, increments the count, and advances lastActivityAt", () => {
    const s0 = initial();
    const at = "2026-06-01T10:01:00.000Z";
    const s1 = appendTurn(s0, { role: "interviewer", text: "Hello", at });

    expect(s1.recentTurns).toEqual([{ role: "interviewer", text: "Hello", at }]);
    expect(s1.stats.turns).toBe(1);
    expect(s1.stats.lastActivityAt).toBe(at);
    // immutability: original state is untouched
    expect(s0.recentTurns).toEqual([]);
    expect(s0.stats.turns).toBe(0);
  });

  it("keeps only the most recent turns in the ring buffer", () => {
    let s = initial();
    const total = RECENT_TURNS_LIMIT + 3;
    for (let i = 1; i <= total; i++) {
      s = appendTurn(s, { role: "candidate", text: `turn ${i}`, at: NOW });
    }
    expect(s.recentTurns).toHaveLength(RECENT_TURNS_LIMIT);
    expect(s.recentTurns[0]?.text).toBe(`turn ${total - RECENT_TURNS_LIMIT + 1}`);
    expect(s.recentTurns.at(-1)?.text).toBe(`turn ${total}`);
    expect(s.stats.turns).toBe(total); // count is cumulative, not buffer length
  });
});
