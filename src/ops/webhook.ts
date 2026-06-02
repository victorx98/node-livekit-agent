import type { JobRecord } from "../types/tracker.js";

// Final-state webhook (§17, MVP). Emit ONE webhook at the end of a job —
// job_completed or job_failed — with a simple bounded retry/backoff. Delivery is
// best-effort: it never throws, because it runs during job teardown and a failed
// webhook must not turn a finished interview into a crash. There is no
// at-least-once delivery or reconciliation marker in the MVP (see §Deferred).

export interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export type WebhookEvent = "job_completed" | "job_failed";

export interface WebhookPayload {
  event: WebhookEvent;
  job: JobRecord;
}

/** Pure: assemble the final-state payload from the durable job record. */
export function buildWebhookPayload(event: WebhookEvent, record: JobRecord): WebhookPayload {
  return { event, job: record };
}

export interface SendWebhookDeps {
  /** Target endpoint; when absent, delivery is skipped (no endpoint configured). */
  url?: string;
  event: WebhookEvent;
  record: JobRecord;
  /** Retries after the first attempt; total attempts = maxRetries + 1. */
  maxRetries: number;
  /** Base backoff; attempt N (0-indexed) sleeps baseMs * 2**N before the next try. */
  baseMs: number;
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: MinimalLogger;
}

export interface WebhookDeliveryResult {
  delivered: boolean;
  skipped?: boolean;
  attempts: number;
}

export async function sendWebhook(deps: SendWebhookDeps): Promise<WebhookDeliveryResult> {
  const { url, event, record, maxRetries, baseMs, fetchFn, sleep, log } = deps;

  if (!url) {
    log.info({ event: "webhook_skipped", webhook_event: event }, "no WEBHOOK_URL configured");
    return { delivered: false, skipped: true, attempts: 0 };
  }

  const body = JSON.stringify(buildWebhookPayload(event, record));
  const totalAttempts = maxRetries + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.ok) {
        log.info(
          { event: "webhook_delivered", webhook_event: event, attempts: attempt + 1 },
          "final-state webhook delivered",
        );
        return { delivered: true, attempts: attempt + 1 };
      }
      log.warn(
        { event: "webhook_attempt_failed", webhook_event: event, status: res.status, attempt },
        "webhook returned a non-2xx response",
      );
    } catch (err) {
      log.warn(
        { event: "webhook_attempt_failed", webhook_event: event, attempt, err },
        "webhook request threw",
      );
    }

    const isLast = attempt === totalAttempts - 1;
    if (!isLast) await sleep(baseMs * 2 ** attempt);
  }

  log.error(
    { event: "webhook_delivery_failed", webhook_event: event, jobId: record.jobId, attempts: totalAttempts },
    "final-state webhook failed after all retries",
  );
  return { delivered: false, attempts: totalAttempts };
}
