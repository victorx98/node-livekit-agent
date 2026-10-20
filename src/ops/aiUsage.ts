interface ModalTokens {
  textTokens: number;
  audioTokens: number;
  imageTokens: number;
}

export interface RealtimeUsageMetrics {
  requestId: string;
  timestamp: number;
  durationMs: number;
  cancelled: boolean;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  inputTokenDetails: ModalTokens & { cachedTokens: number; cachedTokensDetails?: ModalTokens };
  outputTokenDetails: ModalTokens;
}

interface UsageContext {
  jobId: string;
  interviewId: string;
  provider: string;
  model: string;
  environment: string;
  billingChannel: string;
  connectionId: string;
}

const modalities = ["text", "audio", "image"] as const;
const total = (details: ModalTokens) =>
  details.textTokens + details.audioTokens + details.imageTokens;

export function buildUsageReceipt(metrics: RealtimeUsageMetrics, context: UsageContext) {
  const units: Record<string, number | null> = {};
  const input = metrics.inputTokenDetails;
  const cached = input.cachedTokens;
  // Both plugins zero-fill absent usage. Do not present that ambiguity as a free turn.
  const unknown = metrics.inputTokens === 0 && metrics.outputTokens === 0;
  if (unknown || total(input) !== metrics.inputTokens ||
      (cached > 0 && (!input.cachedTokensDetails || total(input.cachedTokensDetails) !== cached))) {
    units.input_unknown = null;
  } else {
    for (const modality of modalities) {
      const key = `${modality}Tokens` as const;
      const hit = input.cachedTokensDetails?.[key] ?? 0;
      if (hit > input[key]) {
        units.input_unknown = null;
        continue;
      }
      if (input[key] - hit) units[`input_${modality}`] = input[key] - hit;
      if (hit) units[`cache_read_${modality}`] = hit;
    }
  }
  for (const modality of modalities) {
    const tokens = metrics.outputTokenDetails[`${modality}Tokens`];
    if (tokens) units[`output_${modality}`] = tokens;
  }
  const remainder = metrics.outputTokens - total(metrics.outputTokenDetails);
  if (remainder > 0 && remainder === metrics.reasoningTokens) {
    units.output_text = (units.output_text ?? 0) + remainder;
  } else if (unknown || remainder !== 0) {
    units.output_unknown = null;
  }
  return {
    source: "livekit" as const,
    environment: context.environment,
    service: "interview",
    operation: "realtime",
    runId: context.interviewId,
    callId: `${context.jobId}:${context.connectionId}:${metrics.requestId || metrics.timestamp}`,
    attemptNo: 1,
    provider: context.provider === "google" ? "gemini" : context.provider,
    billingChannel: context.billingChannel,
    requestedModel: context.model,
    ...(metrics.requestId ? { providerResponseId: metrics.requestId } : {}),
    startedAt: new Date(metrics.timestamp).toISOString(),
    completedAt: new Date(metrics.timestamp + Math.max(0, metrics.durationMs)).toISOString(),
    status: metrics.cancelled ? "interrupted" as const : "completed" as const,
    usage: {
      inputTokens: unknown ? null : metrics.inputTokens,
      cachedInputTokens: unknown ? null : cached,
      outputTokens: unknown ? null : metrics.outputTokens,
      units,
    },
  };
}

export async function deliverUsage(
  receipt: ReturnType<typeof buildUsageReceipt>,
  deps: {
    url: string;
    token: string;
    fetchFn: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const body = JSON.stringify(receipt);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await deps.fetchFn(deps.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return true;
    } catch {
      // Retrying this receipt never replays a model response.
    }
    if (attempt < 2) await deps.sleep(250 * 2 ** attempt);
  }
  return false;
}
