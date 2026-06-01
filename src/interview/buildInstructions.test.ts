import { describe, it, expect } from "vitest";
import { buildInterviewInstructions } from "./buildInstructions.js";
import { resolveJobConfig } from "../config/resolveConfig.js";
import { sampleAgentMetadata } from "../config/sampleMetadata.js";
import type { AgentMetadata } from "../types/job.js";

function cfgFrom(mutate?: (m: AgentMetadata) => void) {
  const m = sampleAgentMetadata();
  mutate?.(m);
  return resolveJobConfig(JSON.stringify(m), "job_x");
}

describe("buildInterviewInstructions (§12)", () => {
  it("includes the interview title, role, duration, and language", () => {
    const out = buildInterviewInstructions(cfgFrom());
    expect(out).toContain("Node.js Backend Engineer @ MentorX (technical)");
    expect(out).toContain("Node.js Backend Engineer");
    expect(out).toContain("60 minutes");
    expect(out).toContain("en-US");
  });

  it("numbers planned questions and renders focus + sub-points", () => {
    const out = buildInterviewInstructions(cfgFrom());
    expect(out).toContain("1. Tell me about your backend experience.");
    expect(out).toContain("Focus: Warm-up; gauge depth.");
    expect(out).toContain("- scale");
    expect(out).toContain("- ownership");
    expect(out).toContain("2. How would you debug a production latency issue?");
  });

  it("falls back to generated-questions guidance when none are provided", () => {
    const out = buildInterviewInstructions(
      cfgFrom((m) => {
        m.interviewData.interview_questions = [];
      }),
    );
    expect(out).toContain("No fixed questions were provided");
  });

  it("includes candidate context when present", () => {
    const out = buildInterviewInstructions(cfgFrom());
    expect(out).toContain("Candidate: Jordan Lee");
    expect(out).toContain("Experience level: entry");
    expect(out).toContain("Background: CS senior, 2 internships");
  });

  it("omits the candidate-context block when no candidate details exist", () => {
    const out = buildInterviewInstructions(
      cfgFrom((m) => {
        m.interviewData.student = { name: "", email: null };
      }),
    );
    expect(out).not.toContain("Candidate context:");
  });

  it("embeds the system guidance prompt", () => {
    const out = buildInterviewInstructions(
      cfgFrom((m) => {
        m.systemInstruction = "BE RIGOROUS AND FAIR.";
      }),
    );
    expect(out).toContain("BE RIGOROUS AND FAIR.");
  });

  it("includes the company section when a company is set", () => {
    const out = buildInterviewInstructions(cfgFrom());
    expect(out).toContain("Company:");
    expect(out).toContain("MentorX");
  });

  it("omits the company section when company is empty", () => {
    const out = buildInterviewInstructions(
      cfgFrom((m) => {
        m.interviewData.company = "";
      }),
    );
    expect(out).not.toContain("Company:");
  });

  it("always encodes turn-taking and completion guidance for autonomy", () => {
    const out = buildInterviewInstructions(cfgFrom());
    expect(out).toContain("one question at a time");
    expect(out.toLowerCase()).toContain("interrupt");
    expect(out.toLowerCase()).toContain("wrap-up");
  });
});
