#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const { fetch, AbortSignal, URL } = globalThis;
const config = parseEnv(readFileSync(process.argv[2] ?? ".env.sa2", "utf8"));
if (!config.GRAFANA_URL?.startsWith("https://") || !config.GRAFANA_SERVICE_ACCOUNT_TOKEN) {
  throw new Error(
    "Grafana query URL and service-account token are required in the existing env file",
  );
}
const probe = spawnSync("docker", ["exec", "-i", "agent-sa2", "node", "--input-type=module"], {
  input: readFileSync("scripts/check-sa2-telemetry.mjs", "utf8"),
  encoding: "utf8",
  timeout: 15000,
});
if (probe.status !== 0)
  throw new Error("Synthetic child probe failed; inspect agent-sa2 health and collector readiness");
const marker = JSON.parse(probe.stdout.trim());
const uid = {
  logs: config.GRAFANA_LOKI_UID ?? "grafanacloud-logs",
  traces: config.GRAFANA_TEMPO_UID ?? "grafanacloud-traces",
  metrics: config.GRAFANA_PROM_UID ?? "grafanacloud-prom",
};
async function query(datasource, path, params = {}) {
  const url = new URL(`${config.GRAFANA_URL}/api/datasources/proxy/uid/${uid[datasource]}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.GRAFANA_SERVICE_ACCOUNT_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${datasource} query returned HTTP ${response.status}`);
  return response.json();
}
const deadline = Date.now() + 60000;
let failure = "No matching receipt yet";
while (Date.now() < deadline) {
  try {
    const now = Date.now();
    const [logs, trace, metrics] = await Promise.all([
      query("logs", "/loki/api/v1/query_range", {
        query: `{service_name="sa2-interview-agent",service_namespace="sa2"} |= "${marker.check_id}"`,
        start: `${now - 300000}000000`,
        end: `${now}000000`,
        limit: 10,
      }),
      query("traces", `/api/traces/${marker.trace_id}`),
      query("metrics", "/api/v1/query", {
        query: 'worker_telemetry_heartbeat_timestamp_seconds{job="sa2/sa2-interview-agent"}',
      }),
    ]);
    const matchedLog = logs.data?.result?.some((stream) =>
      stream.values.some(([, line]) => {
        try {
          const record = JSON.parse(line);
          return (
            record.trace_id === marker.trace_id &&
            record.check_id === marker.check_id &&
            record.synthetic === true
          );
        } catch {
          return false;
        }
      }),
    );
    const spans = (trace.batches ?? trace.resourceSpans ?? []).flatMap((batch) =>
      (batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? []).flatMap(
        (scope) => scope.spans ?? [],
      ),
    );
    const spanNames = spans.map((span) => span.name);
    const matchedTrace = [
      "telemetry.child_delivery_check",
      "agent_session.synthetic_delivery_check",
    ].every((name) => spanNames.includes(name));
    const freshMetric = metrics.data?.result?.some(
      (series) => now / 1000 - Number(series.value[1]) < 60,
    );
    if (matchedLog && matchedTrace && freshMetric) {
      console.log(
        JSON.stringify(
          {
            checked_at: new Date().toISOString(),
            stack: config.GRAFANA_URL,
            ...marker,
            log_received: true,
            trace_received: true,
            fresh_metrics: true,
            span_names: spanNames,
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    failure = `log=${Boolean(matchedLog)} trace=${matchedTrace} fresh_metrics=${Boolean(freshMetric)}`;
  } catch (error) {
    failure = error.message;
  }
  await new Promise((done) => setTimeout(done, 2000));
}
throw new Error(`SA2 Grafana receipt verification timed out: ${failure}`);
