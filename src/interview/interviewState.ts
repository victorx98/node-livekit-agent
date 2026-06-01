// Deterministic interview state (§13). Provider-independent local state that a
// reconnect/reseed will later rebuild context from. MVP keeps it deterministic —
// no model-based summary. This module is pure: no Redis, no LiveKit. Persistence
// lives in src/state/redisStore.ts.

export type TurnRole = "interviewer" | "candidate";

export interface InterviewTurn {
  role: TurnRole;
  text: string;
  at: string;
}

export interface InterviewState {
  jobId: string;
  interviewId: string;

  currentQuestionIndex: number;
  askedQuestionIds: number[]; // indices already covered
  unansweredTopics: number[]; // planned questions not yet covered

  // Deterministic only (e.g. keyword tags) — NOT a model summary in MVP.
  notes: string[];

  recentTurns: InterviewTurn[]; // ring buffer, last RECENT_TURNS_LIMIT

  providerResume?: {
    openaiSessionId?: string;
  };

  stats: {
    turns: number;
    reconnects: number;
    startedAt: string;
    lastActivityAt: string;
  };
}

export const RECENT_TURNS_LIMIT = 12;

export function createInitialState(args: {
  jobId: string;
  interviewId: string;
  questionCount: number;
  now: string;
}): InterviewState {
  return {
    jobId: args.jobId,
    interviewId: args.interviewId,
    currentQuestionIndex: 0,
    askedQuestionIds: [],
    unansweredTopics: Array.from({ length: args.questionCount }, (_, i) => i),
    notes: [],
    recentTurns: [],
    stats: {
      turns: 0,
      reconnects: 0,
      startedAt: args.now,
      lastActivityAt: args.now,
    },
  };
}

/**
 * Append a turn, returning a new state (immutable). Keeps only the most recent
 * RECENT_TURNS_LIMIT turns; the cumulative turn count is tracked separately in
 * stats.turns so it is not capped by the buffer.
 */
export function appendTurn(state: InterviewState, turn: InterviewTurn): InterviewState {
  const recentTurns = [...state.recentTurns, turn].slice(-RECENT_TURNS_LIMIT);
  return {
    ...state,
    recentTurns,
    stats: {
      ...state.stats,
      turns: state.stats.turns + 1,
      lastActivityAt: turn.at,
    },
  };
}
