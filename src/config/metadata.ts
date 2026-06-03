export interface ExtractedJobMetadata {
  source: string;
  metadata: Record<string, unknown>;
}

interface CandidateSource {
  source: string;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function decodeMetadataValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return value;
}

function parseMetadataValue(value: unknown): Record<string, unknown> | undefined {
  const decoded = decodeMetadataValue(value);
  if (decoded === undefined || decoded === null) return undefined;

  if (typeof decoded === "string") {
    const trimmed = decoded.trim();
    if (!trimmed) return undefined;
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      throw new Error("metadata JSON must be an object");
    }
    return parsed;
  }

  if (isRecord(decoded)) return decoded;

  throw new Error(`metadata must be a JSON object or JSON string, got ${typeof decoded}`);
}

function metadataSources(ctx: unknown): CandidateSource[] {
  return [
    { source: "ctx.room.metadata", value: getPath(ctx, ["room", "metadata"]) },
    {
      source: "ctx.job.accept_arguments.metadata",
      value: getPath(ctx, ["job", "accept_arguments", "metadata"]),
    },
    {
      source: "ctx.job.acceptArguments.metadata",
      value: getPath(ctx, ["job", "acceptArguments", "metadata"]),
    },
    { source: "ctx.job.job.metadata", value: getPath(ctx, ["job", "job", "metadata"]) },
    { source: "ctx.job.metadata", value: getPath(ctx, ["job", "metadata"]) },
    { source: "ctx.job.request.metadata", value: getPath(ctx, ["job", "request", "metadata"]) },
  ];
}

export function extractJobMetadata(ctx: unknown): ExtractedJobMetadata {
  const invalidSources: string[] = [];

  for (const candidate of metadataSources(ctx)) {
    try {
      const metadata = parseMetadataValue(candidate.value);
      if (metadata) return { source: candidate.source, metadata };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      invalidSources.push(`${candidate.source}: ${message}`);
    }
  }

  if (invalidSources.length > 0) {
    throw new Error(`No valid agent metadata found. Invalid sources: ${invalidSources.join("; ")}`);
  }

  throw new Error("No agent metadata found in LiveKit room or job context.");
}
