import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

let buildDir: string;
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "sa2-telemetry-test-"));
  await promisify(execFile)(process.execPath, [
    resolve("node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json",
    "--outDir",
    buildDir,
  ]);
  await symlink(resolve("node_modules"), join(buildDir, "node_modules"));
  await writeFile(join(buildDir, "package.json"), JSON.stringify({ type: "module" }));
}, 30000);
afterAll(async () => {
  if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  servers.length = 0;
});

async function runProbe(endpoint?: string, withTraces = true, fail = false, childProcess = false) {
  const source = `
    import { startTelemetry, getChildTelemetry, getActiveTraceFields } from '${buildDir}/ops/telemetry.js';
    const handle = ${childProcess ? `await getChildTelemetry('test-agent', ${JSON.stringify(endpoint)})` : `await startTelemetry({serviceName:'test-agent',endpoint:${JSON.stringify(endpoint)},withTraces:${withTraces}})`};
    await handle.withSpan('delivery.check', {synthetic:true}, async () => {
      console.log(JSON.stringify(getActiveTraceFields()));
      handle.metrics.recordingStarted();
      ${childProcess ? `const {telemetry: {tracer}} = await import('@livekit/agents'); await tracer.startActiveSpan(async () => {}, {name:'agent_session'});` : ""}
      if (${fail}) throw new Error('private-prompt-and-secret');
    }).catch(() => {});
    await handle.flush();
    await handle.shutdown();
  `;
  // Isolate OTel's process-global providers between cases and use real exporters.
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: resolve("."),
    env: { ...process.env, OTEL_EXPORTER_OTLP_HEADERS: "", OTEL_TRACES_EXPORTER: "otlp" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((done) => child.on("close", done));
  expect(code, stderr).toBe(0);
  expect(stderr).not.toContain("private-prompt-and-secret");
  return JSON.parse(stdout.trim());
}

async function collector(status = 200) {
  const requests: { path: string; contentType: string | undefined; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      res.writeHead(status, { "Content-Type": "application/x-protobuf" });
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector did not bind TCP");
  return { requests, endpoint: `http://127.0.0.1:${address.port}/` };
}

describe("OTLP delivery", () => {
  it("keeps application work successful when the collector rejects an export", async () => {
    const c = await collector(401);
    expect((await runProbe(c.endpoint)).trace_id).toMatch(/^[a-f0-9]{32}$/);
    expect(c.requests.length).toBeGreaterThan(0);
  });
  it("exports LiveKit session spans from the interview child provider", async () => {
    const c = await collector();
    const context = await runProbe(c.endpoint, true, false, true);
    const body = c.requests.find((r) => r.path === "/v1/traces")?.body;
    expect(body?.includes(Buffer.from("agent_session"))).toBe(true);
    expect(body?.includes(Buffer.from(context.trace_id, "hex"))).toBe(true);
  });
  it("exports protobuf metrics and a correlated span to normalized signal paths", async () => {
    const c = await collector();
    const context = await runProbe(c.endpoint);
    expect(context.trace_id).toMatch(/^[a-f0-9]{32}$/);
    expect(context.span_id).toMatch(/^[a-f0-9]{16}$/);
    expect([...new Set(c.requests.map((r) => r.path))].sort()).toEqual([
      "/v1/metrics",
      "/v1/traces",
    ]);
    expect(c.requests.every((r) => r.contentType === "application/x-protobuf")).toBe(true);
    expect(
      c.requests
        .find((r) => r.path === "/v1/traces")
        ?.body.includes(Buffer.from(context.trace_id, "hex")),
    ).toBe(true);
  });

  it("does not activate providers when the endpoint is absent", async () => {
    expect(await runProbe()).toEqual({});
  });

  it("explicitly suppresses traces even when the environment enables them", async () => {
    const c = await collector();
    expect(await runProbe(c.endpoint, false)).toEqual({});
    expect([...new Set(c.requests.map((r) => r.path))]).toEqual(["/v1/metrics"]);
  });

  it("ends failed spans without exporting the private error message", async () => {
    const c = await collector();
    await runProbe(c.endpoint, true, true);
    const body = c.requests.find((r) => r.path === "/v1/traces")?.body;
    expect(body).toBeDefined();
    expect(body?.includes(Buffer.from("private-prompt-and-secret"))).toBe(false);
    expect(body?.includes(Buffer.from("error.type"))).toBe(true);
  });
});
