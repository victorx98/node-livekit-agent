// Application metrics contract (§20). The interview code depends on this small
// interface, never on OpenTelemetry directly, so instrumentation is testable
// with a fake and telemetry stays optional (a no-op when OTel is not configured).
// The OTel-backed implementation lives in telemetry.ts; worker-level gauges
// (concurrent jobs, load ratio) are observed there from the server, not here.

export interface JobLabels {
  provider: string;
  model: string;
}

export interface FailureLabels extends JobLabels {
  reason: string;
}

export interface Metrics {
  jobStarted(labels: JobLabels): void;
  jobCompleted(labels: JobLabels): void;
  jobFailed(labels: FailureLabels): void;
  jobDurationSeconds(seconds: number, labels: JobLabels): void;
  providerReconnect(labels: JobLabels): void;
  recordingStarted(): void;
  recordingStartFailed(): void;
  redisWriteFailed(): void;
  webhookFailed(): void;
}

/** Metrics sink that does nothing — used when OTel is not configured. */
export function createNoopMetrics(): Metrics {
  return {
    jobStarted() {},
    jobCompleted() {},
    jobFailed() {},
    jobDurationSeconds() {},
    providerReconnect() {},
    recordingStarted() {},
    recordingStartFailed() {},
    redisWriteFailed() {},
    webhookFailed() {},
  };
}

export interface RecordedCall {
  event: string;
  labels?: object;
  value?: number;
}

/** In-memory Metrics double for tests; records every instrument call. */
export class FakeMetrics implements Metrics {
  readonly calls: RecordedCall[] = [];

  private record(event: string, extra: Omit<RecordedCall, "event"> = {}): void {
    this.calls.push({ event, ...extra });
  }

  count(event: string): number {
    return this.calls.filter((c) => c.event === event).length;
  }

  jobStarted(labels: JobLabels): void {
    this.record("jobStarted", { labels });
  }
  jobCompleted(labels: JobLabels): void {
    this.record("jobCompleted", { labels });
  }
  jobFailed(labels: FailureLabels): void {
    this.record("jobFailed", { labels });
  }
  jobDurationSeconds(seconds: number, labels: JobLabels): void {
    this.record("jobDurationSeconds", { value: seconds, labels });
  }
  providerReconnect(labels: JobLabels): void {
    this.record("providerReconnect", { labels });
  }
  recordingStarted(): void {
    this.record("recordingStarted");
  }
  recordingStartFailed(): void {
    this.record("recordingStartFailed");
  }
  redisWriteFailed(): void {
    this.record("redisWriteFailed");
  }
  webhookFailed(): void {
    this.record("webhookFailed");
  }
}
