import type { JobTracker } from "../jobTracker.js";
import type { ReadinessState } from "../readiness.js";

// Pure monitoring API routing (§20). Each request maps to a status + JSON body,
// independent of the HTTP server, so the routes are unit-testable without
// sockets. Private by default (bound internally by the server); never exposes
// transcripts — only job records, which carry no transcript content.

export interface MonitoringDeps {
  tracker: JobTracker;
  readiness: ReadinessState;
}

export interface MonitoringRequest {
  method: string;
  path: string;
}

export interface MonitoringResponse {
  status: number;
  body: unknown;
}

/** Strip the query string and any trailing slash (except root). */
function normalizePath(path: string): string {
  const noQuery = path.split("?")[0] ?? "";
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery;
}

export async function dispatch(
  req: MonitoringRequest,
  deps: MonitoringDeps,
): Promise<MonitoringResponse> {
  const method = req.method.toUpperCase();
  const path = normalizePath(req.path);

  if (path === "/healthz") {
    return method === "GET" ? { status: 200, body: { status: "ok" } } : methodNotAllowed();
  }

  if (path === "/readyz") {
    if (method !== "GET") return methodNotAllowed();
    return deps.readiness.isReady()
      ? { status: 200, body: { status: "ready" } }
      : { status: 503, body: { status: "draining" } };
  }

  if (path === "/metrics") {
    if (method !== "GET") return methodNotAllowed();
    // Metrics are pushed to the OTLP collector; there is no Prometheus scrape
    // endpoint. Report that honestly rather than returning an empty 200.
    return {
      status: 501,
      body: { error: "metrics are exported via OTLP push; no Prometheus scrape endpoint" },
    };
  }

  if (path === "/jobs") {
    if (method !== "GET") return methodNotAllowed();
    return { status: 200, body: { jobs: await deps.tracker.list() } };
  }

  const cancelMatch = path.match(/^\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch?.[1]) {
    if (method !== "POST") return methodNotAllowed();
    const jobId = decodeURIComponent(cancelMatch[1]);
    const existing = await deps.tracker.get(jobId);
    if (!existing) return notFound();
    // Control plane for cancellation: record intent. Cross-process enforcement
    // (the running child observing this and ending the interview) is deferred.
    await deps.tracker.update(jobId, { status: "cancelled" });
    return { status: 202, body: { status: "cancelling", jobId } };
  }

  const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch?.[1]) {
    if (method !== "GET") return methodNotAllowed();
    const jobId = decodeURIComponent(jobMatch[1]);
    const record = await deps.tracker.get(jobId);
    return record ? { status: 200, body: record } : notFound();
  }

  return notFound();
}

function notFound(): MonitoringResponse {
  return { status: 404, body: { error: "not found" } };
}

function methodNotAllowed(): MonitoringResponse {
  return { status: 405, body: { error: "method not allowed" } };
}
