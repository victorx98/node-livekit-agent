import type { ResolvedJobConfig } from "../types/config.js";
import type { InterviewState } from "./interviewState.js";
import { buildInterviewInstructions } from "./buildInstructions.js";

// Reseed context (§12 reseed note, §13). On a fresh start the seed is just the
// full instruction block. On reconnect we additionally supply a recap built from
// deterministic state — covered/pending questions and recent turns — so a brand
// new realtime session can continue coherently instead of restarting. Pure: no
// Redis, no LiveKit.

export interface ReseedSeed {
  instructions: string;
  recap?: string;
}

function questionText(cfg: ResolvedJobConfig, index: number): string | undefined {
  return cfg.interview.questions[index]?.question_text;
}

function listQuestions(cfg: ResolvedJobConfig, indices: number[]): string {
  const texts = indices
    .map((i) => questionText(cfg, i))
    .filter((t): t is string => t !== undefined);
  return texts.length ? texts.map((t) => `  - ${t}`).join("\n") : "  (none)";
}

function buildRecap(cfg: ResolvedJobConfig, state: InterviewState): string {
  const recentTurns = state.recentTurns.length
    ? state.recentTurns.map((t) => `  ${t.role}: ${t.text}`).join("\n")
    : "  (no turns captured yet)";

  return [
    "This interview is resuming after a connection interruption.",
    "Continue naturally from where you left off. Do not restart the interview or re-introduce yourself.",
    "",
    `Current question index: ${state.currentQuestionIndex}`,
    "Questions already covered:",
    listQuestions(cfg, state.askedQuestionIds),
    "Still to cover:",
    listQuestions(cfg, state.unansweredTopics),
    "",
    "Recent conversation (most recent last):",
    recentTurns,
  ].join("\n");
}

export function buildReseedContext(
  cfg: ResolvedJobConfig,
  state: InterviewState,
  isReseed: boolean,
): ReseedSeed {
  const instructions = buildInterviewInstructions(cfg);
  if (!isReseed) return { instructions };
  return { instructions, recap: buildRecap(cfg, state) };
}
