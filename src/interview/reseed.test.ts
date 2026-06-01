import { describe, it, expect } from "vitest";
import { buildReseedContext } from "./reseed.js";
import { resolveJobConfig } from "../config/resolveConfig.js";
import { sampleAgentMetadata } from "../config/sampleMetadata.js";
import { createInitialState, appendTurn, type InterviewState } from "./interviewState.js";
import type { AgentMetadata } from "../types/job.js";

const NOW = "2026-06-01T10:00:00.000Z";

function cfgFrom(mutate?: (m: AgentMetadata) => void) {
  const m = sampleAgentMetadata();
  mutate?.(m);
  return resolveJobConfig(JSON.stringify(m), "job_x");
}

function stateWith(overrides: Partial<InterviewState>): InterviewState {
  return {
    ...createInitialState({ jobId: "job_x", interviewId: "int_789", questionCount: 2, now: NOW }),
    ...overrides,
  };
}

describe("buildReseedContext (§12 reseed / §13)", () => {
  it("returns the full instructions and no recap on the first attempt", () => {
    const seed = buildReseedContext(cfgFrom(), stateWith({}), false);
    expect(seed.instructions).toContain("You are an AI interviewer");
    expect(seed.recap).toBeUndefined();
  });

  it("returns the full instructions plus a recap on reseed", () => {
    const seed = buildReseedContext(cfgFrom(), stateWith({}), true);
    expect(seed.instructions).toContain("You are an AI interviewer");
    expect(seed.recap).toBeDefined();
    // It must tell the model to continue, not restart.
    expect(seed.recap?.toLowerCase()).toContain("resuming");
    expect(seed.recap?.toLowerCase()).toMatch(/do not (restart|re-introduce|reintroduce)/);
  });

  it("names covered and still-to-cover questions by text in the recap", () => {
    const state = stateWith({
      currentQuestionIndex: 1,
      askedQuestionIds: [0],
      unansweredTopics: [1],
    });
    const recap = buildReseedContext(cfgFrom(), state, true).recap ?? "";
    expect(recap).toContain("Tell me about your backend experience.");
    expect(recap).toContain("How would you debug a production latency issue?");
    expect(recap).toContain("1"); // current question index
  });

  it("includes recent turns in the recap", () => {
    let state = stateWith({});
    state = appendTurn(state, {
      role: "interviewer",
      text: "Tell me about your experience.",
      at: NOW,
    });
    state = appendTurn(state, { role: "candidate", text: "I built a payments service.", at: NOW });
    const recap = buildReseedContext(cfgFrom(), state, true).recap ?? "";
    expect(recap).toContain("I built a payments service.");
    expect(recap.toLowerCase()).toContain("candidate");
  });

  it("is safe when there is no covered or pending progress yet", () => {
    const state = stateWith({ askedQuestionIds: [], unansweredTopics: [], recentTurns: [] });
    const recap = buildReseedContext(cfgFrom(), state, true).recap ?? "";
    expect(recap.length).toBeGreaterThan(0);
    expect(recap.toLowerCase()).toContain("resuming");
  });
});
