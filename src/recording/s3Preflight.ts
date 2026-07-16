import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

// Thin S3 preflight adapter (§16). The only module that talks to S3. It proves,
// before the interview starts, that the bucket exists and the credentials can
// write and delete — so a misconfigured recording fails fast (and, when
// recording is required, fails the job) rather than silently producing nothing.

export interface S3PreflightConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** The object key the recording will use; the probe writes next to it. */
  key: string;
}

/** Probe object key written and deleted during preflight (pure, testable). */
export function preflightObjectKey(key: string): string {
  return `${key}.preflight`;
}

function assertConfigured(config: S3PreflightConfig): void {
  const missing = (["region", "accessKeyId", "secretAccessKey", "bucket", "key"] as const).filter(
    (field) => config[field].trim() === "",
  );
  if (missing.length > 0) {
    throw new Error(`S3 preflight misconfigured; missing: ${missing.join(", ")}`);
  }
}

/**
 * Build the S3 preflight thunk the Recorder calls. Runs PutObject ->
 * DeleteObject; any failure rejects with a descriptive, contextual error.
 *
 * Deliberately no HeadBucket: it requires s3:ListBucket, which least-privilege
 * recording credentials often lack, while Egress itself only writes objects.
 * The probe write already proves the bucket exists (NoSuchBucket otherwise).
 */
export function createS3Preflight(config: S3PreflightConfig): () => Promise<void> {
  return async () => {
    assertConfigured(config);

    const client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    const probeKey = preflightObjectKey(config.key);

    try {
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: probeKey, Body: "preflight" }),
      );
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: probeKey }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`S3 preflight failed for bucket "${config.bucket}": ${reason}`, {
        cause: err,
      });
    } finally {
      client.destroy();
    }
  };
}
