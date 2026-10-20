import { hostname } from "node:os";
import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
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
  /** Export pending telemetry without closing process-global providers. */
  flush: () => Promise<void>;
  withSpan: <T>(name: string, attributes: Attributes, work: () => Promise<T>) => Promise<T>;
  /** The OTel meter, when telemetry is enabled (for worker-level gauges). */
  meter?: Meter;
}

export interface StartTelemetryOptions {
  serviceName: string;
  endpoint?: string;
  /** Explicitly enable tracing in this process (parent or interview child). */
  withTraces?: boolean;
  withLiveKit?: boolean;
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
    return {
      metrics: createNoopMetrics(),
      shutdown: async () => {},
      flush: async () => {},
      withSpan: (_name, _attributes, work) => work(),
    };
  }

  const [contextSdk, metricSdk, metricExp, traceExp, api, traceSdk, resources] = await Promise.all([
    import("@opentelemetry/context-async-hooks"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-metrics-otlp-proto"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/api"),
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/resources"),
  ]);

  activeApi = api;
  // Exporter diagnostics otherwise disappear with OTel's default no-op logger.
  // Do not forward SDK arguments: they can contain headers or private payloads.
  const diagnostic = () =>
    console.error(
      JSON.stringify({
        level: 50,
        event: "telemetry_export_error",
        service: opts.serviceName,
        msg: "OpenTelemetry reported an error; inspect collector delivery counters",
      }),
    );
  api.diag.setLogger(
    { error: diagnostic, warn: diagnostic, info: () => {}, debug: () => {}, verbose: () => {} },
    api.DiagLogLevel.WARN,
  );
  const endpoint = opts.endpoint.replace(/\/+$/, "");
  const reader = new metricSdk.PeriodicExportingMetricReader({
    exporter: new metricExp.OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: 15000,
  });
  const processor = opts.withTraces
    ? new traceSdk.BatchSpanProcessor(
        new traceExp.OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      )
    : undefined;
  const resource = resources
    .defaultResource()
    .merge(
      resources.detectResources({
        detectors: [resources.envDetector, resources.hostDetector],
      }),
    )
    .merge(
      resources.resourceFromAttributes({
        "service.name": opts.serviceName,
        "service.instance.id": hostname(),
      }),
    );
  const meters = new metricSdk.MeterProvider({ resource, readers: [reader] });
  api.metrics.setGlobalMeterProvider(meters);
  const livekit =
    opts.withLiveKit && processor
      ? await import("@livekit/agents").then((module) => module.telemetry)
      : undefined;
  const fanout = livekit ? new livekit.FanoutSpanProcessor() : undefined;
  if (processor) fanout?.add(processor);
  const provider = processor
    ? new traceSdk.NodeTracerProvider({
        resource,
        spanProcessors: fanout ? [fanout] : [processor],
      })
    : undefined;
  provider?.register({ contextManager: new contextSdk.AsyncLocalStorageContextManager() });
  if (livekit && provider && fanout) {
    livekit.setTracerProvider(provider, {
      registerSpanProcessor: (p) => fanout.add(p),
      allowPii: false,
    });
  }
  const meter = api.metrics.getMeter(METER_NAME);
  const tracer = api.trace.getTracer(METER_NAME);
  return {
    metrics: new OtelMetrics(meter),
    meter,
    shutdown: async () => {
      await Promise.all([meters.shutdown(), provider?.shutdown()]);
    },
    flush: async () => {
      const results = await Promise.allSettled([reader.forceFlush(), provider?.forceFlush()]);
      if (results.some((result) => result.status === "rejected")) diagnostic();
    },
    withSpan: async (name, attributes, work) => {
      if (!processor) return work();
      return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
          return await work();
        } catch (err) {
          // Exception messages/stacks may contain prompts, credentials, or signed URLs.
          span.setStatus({ code: api.SpanStatusCode.ERROR });
          span.setAttribute("error.type", err instanceof Error ? err.name : "unknown");
          throw err;
        } finally {
          span.end();
        }
      });
    },
  };
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

let childTelemetryPromise: Promise<TelemetryHandle> | undefined;

/** One explicit tracing/metrics provider per reused interview child. */
export function getChildTelemetry(
  serviceName: string,
  endpoint?: string,
): Promise<TelemetryHandle> {
  childTelemetryPromise ??= startTelemetry({
    serviceName,
    endpoint,
    withTraces: true,
    withLiveKit: true,
  });
  return childTelemetryPromise;
}

export async function getChildMetrics(serviceName: string, endpoint?: string): Promise<Metrics> {
  return (await getChildTelemetry(serviceName, endpoint)).metrics;
}

let activeApi: typeof import("@opentelemetry/api") | undefined;
export function getActiveTraceFields(): Record<string, string> {
  const context = activeApi?.trace.getActiveSpan()?.spanContext();
  return context && activeApi?.trace.isSpanContextValid(context)
    ? { trace_id: context.traceId, span_id: context.spanId }
    : {};
}

/** Low-cost idle signal: a correlated log/span plus a freshness gauge. */
export function startTelemetryHeartbeat(
  handle: TelemetryHandle,
  log: { info: (fields: object, message: string) => void },
): () => void {
  if (!handle.meter) return () => {};
  const gauge = handle.meter.createObservableGauge("worker_telemetry_heartbeat_timestamp_seconds", {
    unit: "s",
  });
  gauge.addCallback((result) => result.observe(Date.now() / 1000));
  const beat = () => {
    void handle.withSpan("telemetry.heartbeat", { synthetic: true }, async () => {
      log.info(
        { event: "telemetry_heartbeat", synthetic: true, ...getActiveTraceFields() },
        "telemetry delivery heartbeat",
      );
    });
  };
  beat();
  const timer = setInterval(beat, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
