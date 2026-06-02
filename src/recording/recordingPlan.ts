import type { ResolvedJobConfig } from "../types/config.js";

// Pure recording helpers (§16). No LiveKit, no AWS — just the deterministic
// decisions the recorder and its gateway need.

/**
 * Resolve the S3 object key (Egress filepath) for an interview recording.
 *
 * The backend normally supplies the key directly as `recordingKey`; we use it
 * verbatim so the object lands exactly where the backend expects. When it is
 * absent we fall back to a stable per-interview path. `{time}` is a LiveKit
 * Egress filename token, substituted by LiveKit at recording time.
 */
export function resolveRecordingFilepath(cfg: ResolvedJobConfig): string {
  const key = cfg.recording.key.trim();
  if (key !== "") return key;

  const ext = cfg.recording.audio_only ? "ogg" : "mp4";
  return `interviews/${cfg.interview_id}/${cfg.job_id}-{time}.${ext}`;
}
