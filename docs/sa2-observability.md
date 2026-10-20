# SA2 agent telemetry

The optional Compose override runs a dedicated Alloy collector for `agent-sa2`.
It exports to the SA2 (`mentorxsa2`) Grafana stack. It does not collect or restart
VibeID, Redis, or ArgoLand Alloy.

## Launch

From this repository on the Docker host:

```bash
node scripts/launch-sa2-observability.mjs ../api/.env
```

Requires Node 22, Docker access, and an existing SA2 env file containing a valid
`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` Authorization value.
The launcher checks the credential, validates the exact pinned Alloy image,
builds the SA2 agent, starts the collector, waits for collector readiness, and
recreates SA2. `--no-build` reuses a separately built image. Credentials are
selected from the existing file into process environment, not copied to another
file, printed, or passed in command arguments. Do not print Compose's resolved
configuration or Docker environment: they contain the collector credential.

Use the override for subsequent SA2 launches. Running only the base Compose
file omits the collector service and resource overrides; it is insufficient for
a fresh installation. This host's `.env.sa2` also points at `sa2-alloy` and clears
the invalid direct-write header, so restarting the base agent retains local
collector routing when the collector already exists.
Rotate the credential in its source file, then rerun the launcher to replace
the collector environment. Local env files are ignored by Git and Docker build
contexts.

## Signal behavior

- Pino logs remain structured stdout. Alloy discovers only `/agent-sa2`, drops
  records containing raw conversational fields, redacts tokens, email addresses,
  and S3 query credentials, and sends logs via OTLP to Grafana Loki.
- Parent and interview children export protobuf metrics/traces. Child providers
  start in prewarm before LiveKit Cloud prepares its provider. LiveKit's supported
  fanout hook sends its session spans through the same provider while preserving
  LiveKit Cloud recording behavior; `allowPii: false` enables its privacy filter.
- Logs emitted inside application spans carry `trace_id` and `span_id`. Long-lived
  interview/session spans end on completion; startup/reconnect spans arrive earlier.
- Alloy keeps only approved technical span attributes and exception types. It
  removes prompt/completion data and exception messages/stacks before cloud export.
- Process arguments are excluded from OTel resource detection. Service identity
  is `service.namespace=sa2`, `service.name=sa2-interview-agent`, production,
  container hostname, and the build revision. Uncommitted builds carry `-dirty`.
- Every minute an idle parent emits a synthetic `telemetry.heartbeat` span and
  correlated `telemetry_heartbeat` log. A timestamp gauge exports every 15 seconds.
- Interview child telemetry flushes on job completion and process shutdown. Export
  failures log a safe diagnostic and do not replace the interview outcome.
- Alloy retries up to five minutes with a bounded memory queue (1000 batches).
  Docker log cursor state persists in a named volume. The OTLP queue is in memory;
  an abrupt collector kill can lose buffered telemetry. Graceful flushing also
  cannot guarantee delivery after a hard process/host crash.

## Verify receipt

Check the agent `/healthz`, `/readyz`, zero restart count, LiveKit worker
registration, and `http://127.0.0.1:12346/-/ready`. Then query Grafana:

```logql
{service_name="sa2-interview-agent", service_namespace="sa2"} |= "telemetry_heartbeat"
```

```traceql
{ resource.service.name = "sa2-interview-agent" && name = "telemetry.heartbeat" }
```

Emit a synthetic child/LiveKit-provider check without dispatching an interview:

```bash
docker exec -i agent-sa2 node --input-type=module < scripts/check-sa2-telemetry.mjs
```

Automate all three Grafana receipt checks with the existing query credential:

```bash
node scripts/verify-sa2-grafana.mjs .env.sa2
```

This emits one synthetic child check and requires its matching Loki log, exact
Tempo trace containing both child and LiveKit synthetic spans, and a heartbeat
metric less than 60 seconds old. It retries within a bounded window and exits
nonzero on missing data or query/authentication failure.

Find its `check_id` in Loki and exact `trace_id` in Tempo. The probe uses the
worker stdout destination because ordinary `docker exec` output is not collected.

Find a heartbeat log's exact trace ID in Tempo, rather than treating exporter
configuration as proof. For an interview, query `interview.session`,
`interview.session_start`, and LiveKit `agent_session`, then correlate job IDs.
A synthetic provider check proves routing; it does not prove a live interview.

```promql
worker_telemetry_heartbeat_timestamp_seconds{job="sa2/sa2-interview-agent"}
```

Collector delivery counters are exposed locally at
`http://127.0.0.1:12346/metrics` and selected counters are also exported to Grafana.
Inspect `otelcol_exporter_sent_*`, `otelcol_exporter_send_failed_*`,
`otelcol_receiver_accepted_*`, and `otelcol_receiver_refused_*`.

## Alerting

The ready-to-create [heartbeat alert API request](../observability/sa2-heartbeat-alert.json)
uses the discovered SA2 GrafanaCloud folder and existing Prometheus datasource.
With alert-rule write permission, submit it to `POST /api/v1/provisioning/alert-rules`
using Grafana's [HTTP provisioning API](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/http-api-provisioning/).
This JSON is an API request body, not a file-provisioning import.
Create a Grafana-managed alert in the SA2 stack for this expression, evaluated
every minute, pending five minutes:

```promql
(time() - max(worker_telemetry_heartbeat_timestamp_seconds{job="sa2/sa2-interview-agent"}) > 120)
or absent(worker_telemetry_heartbeat_timestamp_seconds{job="sa2/sa2-interview-agent"})
```

Route it to the existing SA2 operations contact point. Also alert on increasing
collector failed/refused export counters. Alert provisioning requires Grafana
alert-rule write permission; a Viewer service-account token only verifies data.
No contact point or message destination is created by the local launcher.
