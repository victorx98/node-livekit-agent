import { llm } from "@livekit/agents";
import type { TranscriptRole } from "./transcriptStore.js";

// A provider plugin owns recoverable socket/session reconnects. This module is
// only used after a fatal close requires a brand-new AgentSession. It restores
// actual conversation turns without rewriting the API-authored instruction.

export interface ReseedSeed {
  instructions: string;
  chatCtx?: llm.ChatContext;
  recovered: boolean;
}

export interface RecoveryContextLimits {
  maxTurns: number;
  maxChars: number;
}

export interface RecoveryTranscriptTurn {
  role: TranscriptRole;
  text: string;
  at: string;
}

export function selectRecoveryTurns(
  transcript: readonly RecoveryTranscriptTurn[],
  limits: RecoveryContextLimits,
): RecoveryTranscriptTurn[] {
  const selected: RecoveryTranscriptTurn[] = [];
  let usedChars = 0;

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (selected.length >= limits.maxTurns || usedChars >= limits.maxChars) break;

    const turn = transcript[index];
    if (!turn || (turn.role !== "candidate" && turn.role !== "interviewer") || !turn.text) {
      continue;
    }

    const remainingChars = limits.maxChars - usedChars;
    const text = turn.text.length > remainingChars ? turn.text.slice(0, remainingChars) : turn.text;
    if (!text) break;

    selected.push({ role: turn.role, text, at: turn.at });
    usedChars += text.length;
    if (text.length < turn.text.length) break;
  }

  return selected.reverse();
}

export function buildRecoveryChatContext(
  transcript: readonly RecoveryTranscriptTurn[],
  limits: RecoveryContextLimits,
): llm.ChatContext {
  const chatCtx = llm.ChatContext.empty();
  for (const turn of selectRecoveryTurns(transcript, limits)) {
    const createdAt = Date.parse(turn.at);
    chatCtx.addMessage({
      role: turn.role === "candidate" ? "user" : "assistant",
      content: turn.text,
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    });
  }
  return chatCtx;
}

export function buildSessionSeed(
  instructions: string,
  transcript: readonly RecoveryTranscriptTurn[],
  isRecovery: boolean,
  limits: RecoveryContextLimits,
): ReseedSeed {
  if (!isRecovery) return { instructions, recovered: false };
  return {
    instructions,
    chatCtx: buildRecoveryChatContext(transcript, limits),
    recovered: true,
  };
}
