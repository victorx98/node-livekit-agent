#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

// Keep credentials in their existing file. Only selected values enter the
// collector environment; never pass the credential as a command argument.
const { fetch, AbortSignal } = globalThis;

const credentialFile = process.argv[2];
if (!credentialFile)
  throw new Error(
    "Usage: node scripts/launch-sa2-observability.mjs <existing-SA2-OTLP-env-file> [--no-build]",
  );
const source = parseEnv(readFileSync(credentialFile, "utf8"));
const endpoint = source.OTEL_EXPORTER_OTLP_ENDPOINT;
const header = source.OTEL_EXPORTER_OTLP_HEADERS?.split(",").find((part) =>
  /^authorization=/i.test(part.trim()),
);
if (!endpoint?.startsWith("https://otlp-gateway-") || !header) {
  throw new Error(
    "Credential source must contain a Grafana Cloud OTLP endpoint and Authorization header",
  );
}
const authorization = decodeURIComponent(header.slice(header.indexOf("=") + 1).trim());
// Fail before replacing a running worker if the write credential is invalid.
const response = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/metrics`, {
  method: "POST",
  headers: { Authorization: authorization, "Content-Type": "application/json" },
  body: '{"resourceMetrics":[]}',
  signal: AbortSignal.timeout(15000),
});
if (!response.ok)
  throw new Error(`Grafana write credential preflight failed: HTTP ${response.status}`);
const revision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
if (revision.status !== 0) throw new Error("Cannot resolve build revision");
const dirty = spawnSync("git", ["diff", "--quiet"]);
const env = {
  ...process.env,
  SA2_GRAFANA_OTLP_ENDPOINT: endpoint,
  SA2_GRAFANA_OTLP_AUTHORIZATION: authorization,
  SA2_BUILD_REVISION: revision.stdout.trim() + (dirty.status === 1 ? "-dirty" : ""),
};
const compose = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.sa2-observability.yml",
];
function docker(args) {
  const result = spawnSync("docker", args, { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Validate against the same pinned image that will run the collector.
docker([
  "run",
  "--rm",
  "--entrypoint",
  "/bin/alloy",
  "-v",
  `${process.cwd()}/observability/sa2.alloy:/etc/alloy/config.alloy:ro`,
  "grafana/alloy:v1.19.2",
  "validate",
  "/etc/alloy/config.alloy",
]);
if (!process.argv.includes("--no-build")) docker([...compose, "build", "agent-sa2"]);
docker([...compose, "up", "-d", "--no-deps", "sa2-alloy"]);
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  const response = await fetch("http://127.0.0.1:12346/-/ready", {
    signal: AbortSignal.timeout(1000),
  }).catch(() => undefined);
  if (response?.ok) {
    ready = true;
    break;
  }
  await new Promise((done) => setTimeout(done, 500));
}
if (!ready)
  throw new Error(
    "SA2 collector is not ready; agent was not replaced. Inspect docker logs sa2-alloy and retry.",
  );
docker([
  ...compose,
  "up",
  "-d",
  "--no-deps",
  "--force-recreate",
  "--wait",
  "--wait-timeout",
  "90",
  "agent-sa2",
]);
