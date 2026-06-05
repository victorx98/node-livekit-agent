import { describe, expect, it } from "vitest";
import {
  appendTurn,
  createInitialState,
  RECENT_TURNS_LIMIT,
  type InterviewState,
} from "./interviewState.js";

const NOW = "2026-06-01T10:00:00.000Z";

function initial(): InterviewState {
  return createInitialState({
    jobId: "job_1",
    interviewId: "int_1",
    now: NOW,
  });
}

describe("createInitialState (§13)", () => {
  it("stores only durable conversation and lifecycle state", () => {
    const state = initial();
    expect(state).toEqual({
      jobId: "job_1",
      interviewId: "int_1",
      recentTurns: [],
      stats: {
        turns: 0,
        reconnects: 0,
        startedAt: NOW,
        lastActivityAt: NOW,
      },
    });
    expect(state).not.toHaveProperty("askedQuestionIds");
    expect(state).not.toHaveProperty("unansweredTopics");
  });
});

describe("appendTurn (§13)", () => {
  it("records the turn, increments the count, and advances lastActivityAt", () => {
    const state = initial();
    const at = "2026-06-01T10:01:00.000Z";
    const next = appendTurn(state, { role: "interviewer", text: "Hello", at });

    expect(next.recentTurns).toEqual([{ role: "interviewer", text: "Hello", at }]);
    expect(next.stats.turns).toBe(1);
    expect(next.stats.lastActivityAt).toBe(at);
    expect(state.recentTurns).toEqual([]);
  });

  it("keeps only the most recent turns in the in-memory fallback buffer", () => {
    let state = initial();
    const total = RECENT_TURNS_LIMIT + 3;
    for (let index = 1; index <= total; index += 1) {
      state = appendTurn(state, {
        role: "candidate",
        text: `turn ${index}`,
        at: NOW,
      });
    }

    expect(state.recentTurns).toHaveLength(RECENT_TURNS_LIMIT);
    expect(state.recentTurns[0]?.text).toBe(`turn ${total - RECENT_TURNS_LIMIT + 1}`);
    expect(state.stats.turns).toBe(total);
  });
});
