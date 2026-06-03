import { describe, expect, it } from "vitest";
import { extractJobMetadata } from "./metadata.js";

function json(interviewId: string): string {
  return JSON.stringify({ interviewId, interviewData: { position: "Engineer" } });
}

describe("extractJobMetadata", () => {
  it("uses room metadata before job metadata", () => {
    const extracted = extractJobMetadata({
      room: { metadata: json("room-first") },
      job: { metadata: json("job-second") },
    });

    expect(extracted.source).toBe("ctx.room.metadata");
    expect(extracted.metadata.interviewId).toBe("room-first");
  });

  it("falls through invalid room metadata to job accept arguments", () => {
    const extracted = extractJobMetadata({
      room: { metadata: "{ not json" },
      job: { accept_arguments: { metadata: json("accepted") } },
    });

    expect(extracted.source).toBe("ctx.job.accept_arguments.metadata");
    expect(extracted.metadata.interviewId).toBe("accepted");
  });

  it("accepts object metadata payloads", () => {
    const metadata = { interviewId: "object-payload" };

    const extracted = extractJobMetadata({
      job: { job: { metadata } },
    });

    expect(extracted.source).toBe("ctx.job.job.metadata");
    expect(extracted.metadata).toBe(metadata);
  });

  it("accepts byte metadata payloads", () => {
    const extracted = extractJobMetadata({
      job: { metadata: Buffer.from(json("bytes-payload")) },
    });

    expect(extracted.source).toBe("ctx.job.metadata");
    expect(extracted.metadata.interviewId).toBe("bytes-payload");
  });

  it("throws a clear error when every source is empty", () => {
    expect(() => extractJobMetadata({ room: {}, job: {} })).toThrow(/No agent metadata found/);
  });

  it("throws a clear error when every populated source is invalid", () => {
    expect(() =>
      extractJobMetadata({
        room: { metadata: "[]" },
        job: { metadata: "false" },
      }),
    ).toThrow(/No valid agent metadata found/);
  });
});
