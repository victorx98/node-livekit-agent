import { describe, it, expect } from "vitest";
import { resolveRecordingFilepath } from "./recordingPlan.js";
import { resolveJobConfig } from "../config/resolveConfig.js";
import { sampleAgentMetadata } from "../config/sampleMetadata.js";
import type { AgentMetadata } from "../types/job.js";

function cfgFrom(mutate?: (m: AgentMetadata) => void) {
  const m = sampleAgentMetadata();
  mutate?.(m);
  return resolveJobConfig(JSON.stringify(m), "job_123");
}

describe("resolveRecordingFilepath (§16)", () => {
  it("uses the backend-supplied recordingKey verbatim when set", () => {
    const cfg = cfgFrom((m) => {
      m.recordingKey = "livekit-interviews/int_789/job_123.mp4";
    });
    expect(resolveRecordingFilepath(cfg)).toBe("livekit-interviews/int_789/job_123.mp4");
  });

  it("falls back to an interview/job default path with a {time} token when key is empty", () => {
    const cfg = cfgFrom((m) => {
      m.recordingKey = "";
    });
    expect(resolveRecordingFilepath(cfg)).toBe("interviews/int_789/job_123-{time}.mp4");
  });

  it("uses an .ogg extension for the default path when audio_only is set", () => {
    const cfg = cfgFrom((m) => {
      m.recordingKey = "";
    });
    cfg.recording.audio_only = true;
    expect(resolveRecordingFilepath(cfg)).toBe("interviews/int_789/job_123-{time}.ogg");
  });

  it("honors an explicit key even when audio_only is set (the backend owns the key)", () => {
    const cfg = cfgFrom((m) => {
      m.recordingKey = "custom/path/recording.mp4";
    });
    cfg.recording.audio_only = true;
    expect(resolveRecordingFilepath(cfg)).toBe("custom/path/recording.mp4");
  });
});
