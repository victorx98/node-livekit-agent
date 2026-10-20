# SA2 Grafana delivery

## Goal

Deliver SA2 Docker logs, parent telemetry, and interview-child traces to the
mentorxsa2 Grafana stack with matching identity and inspectable receipt.

## Findings

- Existing agent OTLP write credential returns HTTP 401 (invalid token).
- Existing SA2 API OTLP write credential accepts empty telemetry batches.
- ArgoLand Alloy deliberately excludes the SA2 Docker network.
- Child tracing is implicit and LiveKit Cloud can replace its tracer provider.

## Execution

- [x] Add collector-capture tests for exported metrics, traces, correlation,
  disabled telemetry, trace suppression, and safe error attributes.
- [x] Make parent/child OTLP tracing explicit and add idle heartbeat.
- [x] Add SA2-only Alloy/Compose deployment and secret-safe launch script.
- [x] Run project verification and validate the exact Alloy image config.
- [x] Deploy SA2 only and query Loki, Tempo, and Prometheus for synthetic receipt.
- [x] Record live evidence, real-interview verification gap, and alert permission limitation.

## Verification scope

Local synthetic checks must not dispatch paid interviews or emit final-state
webhooks. A naturally occurring real interview can verify the child/session path;
otherwise report this separately from synthetic delivery. Do not modify VibeID,
Redis, or the ArgoLand collector. Existing credentials remain in their existing
file and are passed to Docker in process environment, never logged or copied.

## Verified result (2026-10-14)

- Required `pnpm verify`: 31 suites, 205 tests; lint, typecheck, harness passed.
- Alloy v1.19.2 config validated; deployed SA2 image
  `sha256:fd143b65540165bd9c9457e8870120580f1b8a320f6e0d2e0626ac69b7747d15`.
- Agent health/readiness 200, registered with LiveKit, zero restarts. VibeID,
  Redis, and ArgoLand collector start times/images unchanged.
- Parent heartbeat received in Tempo; current worker metrics received in SA2
  Prometheus. Synthetic child check at 20:53:15 UTC found matching Loki log and
  exact Tempo trace `2512d4db5f8c8419524ed0513aae626e`, including child-provider
  and LiveKit synthetic session spans. Fresh metrics verified automatically.
- Exported trace attributes limited to `synthetic` and `check_id` for that check.
- Existing SA2 API write credential reused without copying to another file.
  This host's local `.env.sa2` routes OTLP to the collector and removes the
  invalid direct-write header. Query credential was supplied by the user.
- Collector receipt inspection initially exposed `unknown_service`; fixed by
  mapping Loki attributes into explicit OTel resource identity. Final logs use
  `service_name=sa2-interview-agent`, `service_namespace=sa2`.
- No real interview dispatched or tested. Child/provider synthetic delivery is
  proven; the first real interview still needs session-trace verification.
- Alert creation remains unavailable: both original query account and the
  user-added `.env.sa2` account expose read-only alert permissions. Prepared
  `observability/sa2-heartbeat-alert.json`; its live expression returns 0 (healthy).
  This is not an installed alert and does not create notification destinations.
