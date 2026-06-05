import type { InterviewRecoverySnapshot } from "../types/config.js";
import type { TranscriptEvent } from "./transcriptStore.js";
import type { RecoveryTranscriptTurn } from "./reseed.js";

export interface RecoveryContextReader {
  getRecoverySnapshot(jobId: string): Promise<InterviewRecoverySnapshot | undefined>;
  getTranscript(jobId: string): Promise<TranscriptEvent[]>;
}

export interface RecoverySource {
  snapshot: InterviewRecoverySnapshot;
  transcript: RecoveryTranscriptTurn[];
  degraded: boolean;
  error?: unknown;
}

export async function loadRecoverySource(args: {
  jobId: string;
  reader: RecoveryContextReader;
  fallbackSnapshot: InterviewRecoverySnapshot;
  fallbackTranscript: RecoveryTranscriptTurn[];
}): Promise<RecoverySource> {
  try {
    const [persistedSnapshot, persistedTranscript] = await Promise.all([
      args.reader.getRecoverySnapshot(args.jobId),
      args.reader.getTranscript(args.jobId),
    ]);
    return {
      snapshot: persistedSnapshot ?? args.fallbackSnapshot,
      transcript: persistedTranscript.length > 0 ? persistedTranscript : args.fallbackTranscript,
      degraded: false,
    };
  } catch (error) {
    return {
      snapshot: args.fallbackSnapshot,
      transcript: args.fallbackTranscript,
      degraded: true,
      error,
    };
  }
}
