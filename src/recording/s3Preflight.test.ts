import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AWS SDK so the preflight can be exercised without S3. Commands are
// stand-in classes that keep their input and name; the client records every
// command passed to send().
const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
let sendImpl: (command: string) => Promise<unknown>;

vi.mock("@aws-sdk/client-s3", () => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class HeadBucketCommand extends FakeCommand {}
  class PutObjectCommand extends FakeCommand {}
  class DeleteObjectCommand extends FakeCommand {}
  class S3Client {
    async send(command: FakeCommand): Promise<unknown> {
      const name = command.constructor.name;
      sent.push({ command: name, input: command.input });
      return sendImpl(name);
    }
    destroy(): void {}
  }
  return { S3Client, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand };
});

const { createS3Preflight, preflightObjectKey } = await import("./s3Preflight.js");

const config = {
  region: "us-west-2",
  accessKeyId: "key",
  secretAccessKey: "secret",
  bucket: "bucket",
  key: "interviews/int_789/job_123.mp4",
};

beforeEach(() => {
  sent.length = 0;
  sendImpl = async () => ({});
});

describe("preflightObjectKey (§16)", () => {
  it("writes the probe next to the recording key so it shares the same prefix permissions", () => {
    expect(preflightObjectKey("interviews/int_789/job_123.mp4")).toBe(
      "interviews/int_789/job_123.mp4.preflight",
    );
  });
});

describe("createS3Preflight (§16)", () => {
  it("writes and deletes a probe object next to the recording key", async () => {
    await createS3Preflight(config)();

    expect(sent).toEqual([
      {
        command: "PutObjectCommand",
        input: expect.objectContaining({
          Bucket: "bucket",
          Key: "interviews/int_789/job_123.mp4.preflight",
        }),
      },
      {
        command: "DeleteObjectCommand",
        input: { Bucket: "bucket", Key: "interviews/int_789/job_123.mp4.preflight" },
      },
    ]);
  });

  it("never sends HeadBucket, so least-privilege credentials without s3:ListBucket pass", async () => {
    await createS3Preflight(config)();

    expect(sent.map((s) => s.command)).not.toContain("HeadBucketCommand");
  });

  it("rejects with a misconfiguration error naming the blank fields before any S3 call", async () => {
    await expect(createS3Preflight({ ...config, bucket: " " })()).rejects.toThrow(
      "S3 preflight misconfigured; missing: bucket",
    );
    expect(sent).toEqual([]);
  });

  it("rejects with a descriptive error naming the bucket when the probe write is denied", async () => {
    const denied = new Error("Access Denied");
    sendImpl = async (command) => {
      if (command === "PutObjectCommand") throw denied;
      return {};
    };

    const failure = await createS3Preflight(config)().catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'S3 preflight failed for bucket "bucket": Access Denied',
    );
    expect((failure as Error & { cause?: unknown }).cause).toBe(denied);
  });
});
