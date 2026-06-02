import type { Counter, Histogram, Meter } from "@opentelemetry/api";
import { createNoopMetrics, type FailureLabels, type JobLabels, type Metrics } from "./metrics.js";

// OpenTelemetry adapter (§20). The only module that imports OTel. It builds a
// Metrics implementation backed by OTLP exporters; everything else depends on
// the Metrics interface. The SDK is loaded via dynamic import and started only
// when OTEL_EXPORTER_OTLP_ENDPOINT is set, so a deployment without a collector
// pays no OTel cost and the realtime audio path stays clean (no
// auto-instrumentation). Each process (parent + each job child) starts its own.

const METER_NAME = "livekit-ai-interview-agent";

export interface TelemetryHandle {
  metrics: Metrics;
  /** Flush + stop exporters; safe no-op when telemetry is disabled. */
  shutdown: () => Promise<void>;
  /** The OTel meter, when telemetry is enabled (for worker-level gauges). */
  meter?: Meter;
}

export interface StartTelemetryOptions {
  serviceName: string;
  endpoint?: string;
  /** Export traces too (parent worker). Children export metrics only. */
  withTraces?: boolean;
}

class OtelMetrics implements Metrics {
  private readonly jobsStarted: Counter;
  private readonly jobsCompleted: Counter;
  private readonly jobsFailed: Counter;
  private readonly duration: Histogram;
  private readonly reconnects: Counter;
  private readonly recordingStartTotal: Counter;
  private readonly recordingStartFailures: Counter;
  private readonly redisWriteFailures: Counter;
  private readonly webhookFailures: Counter;

  constructor(meter: Meter) {
    this.jobsStarted = meter.createCounter("interview_jobs_started_total");
    this.jobsCompleted = meter.createCounter("interview_jobs_completed_total");
    this.jobsFailed = meter.createCounter("interview_jobs_failed_total");
    this.duration = meter.createHistogram("interview_duration_seconds", { unit: "s" });
    this.reconnects = meter.createCounter("provider_reconnects_total");
    this.recordingStartTotal = meter.createCounter("recording_start_total");
    this.recordingStartFailures = meter.createCounter("recording_start_failures_total");
    this.redisWriteFailures = meter.createCounter("redis_write_failures_total");
    this.webhookFailures = meter.createCounter("webhook_failures_total");
  }

  jobStarted(labels: JobLabels): void {
    this.jobsStarted.add(1, { ...labels });
  }
  jobCompleted(labels: JobLabels): void {
    this.jobsCompleted.add(1, { ...labels });
  }
  jobFailed(labels: FailureLabels): void {
    this.jobsFailed.add(1, { ...labels });
  }
  jobDurationSeconds(seconds: number, labels: JobLabels): void {
    this.duration.record(seconds, { ...labels });
  }
  providerReconnect(labels: JobLabels): void {
    this.reconnects.add(1, { ...labels });
  }
  recordingStarted(): void {
    this.recordingStartTotal.add(1);
  }
  recordingStartFailed(): void {
    this.recordingStartFailures.add(1);
  }
  redisWriteFailed(): void {
    this.redisWriteFailures.add(1);
  }
  webhookFailed(): void {
    this.webhookFailures.add(1);
  }
}

export async function startTelemetry(opts: StartTelemetryOptions): Promise<TelemetryHandle> {
  if (!opts.endpoint) {
    return { metrics: createNoopMetrics(), shutdown: async () => {} };
  }

  const [{ NodeSDK }, { PeriodicExportingMetricReader }, metricExp, traceExp, api] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/api"),
    ]);

  const sdk = new NodeSDK({
    serviceName: opts.serviceName,
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new metricExp.OTLPMetricExporter({ url: `${opts.endpoint}/v1/metrics` }),
      }),
    ],
    ...(opts.withTraces
      ? { traceExporter: new traceExp.OTLPTraceExporter({ url: `${opts.endpoint}/v1/traces` }) }
      : {}),
    instrumentations: [],
  });
  sdk.start();

  const meter = api.metrics.getMeter(METER_NAME);
  return { metrics: new OtelMetrics(meter), shutdown: () => sdk.shutdown(), meter };
}

/** Latest worker load sample, refreshed each time the framework calls loadFunc. */
export interface WorkerLoadSource {
  activeJobs(): number;
  loadRatio(): number;
}

/**
 * Register worker-level observable gauges (parent process): concurrent jobs and
 * load ratio. `cli.runApp` hides the AgentServer, but it calls our loadFunc
 * periodically with it, so we read the latest sample those calls record. No-op
 * when telemetry is disabled (no meter).
 */
export function observeWorkerLoad(handle: TelemetryHandle, source: WorkerLoadSource): void {
  if (!handle.meter) return;
  const concurrent = handle.meter.createObservableGauge("worker_concurrent_jobs");
  const loadRatio = handle.meter.createObservableGauge("worker_load_ratio");
  concurrent.addCallback((result) => result.observe(source.activeJobs()));
  loadRatio.addCallback((result) => result.observe(source.loadRatio()));
}

// --- per-process child metrics singleton (used by the job entrypoint) ---

let childMetricsPromise: Promise<Metrics> | undefined;

/**
 * Process-wide Metrics for the job child. Started once and reused across the
 * many entry() invocations a reused child handles. Metrics-only (no traces).
 */
export function getChildMetrics(serviceName: string, endpoint?: string): Promise<Metrics> {
  if (!childMetricsPromise) {
    childMetricsPromise = startTelemetry({ serviceName, endpoint, withTraces: false }).then(
      (handle) => handle.metrics,
    );
  }
  return childMetricsPromise;
}
