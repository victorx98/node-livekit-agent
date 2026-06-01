import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "./logger.js";

/** Capture pino's newline-delimited JSON output into parsed objects. */
function captureSink() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
      cb();
    },
  });
  return { lines, stream };
}

describe("createLogger", () => {
  it("emits structured JSON carrying base fields (service, env)", () => {
    const { lines, stream } = captureSink();
    const log = createLogger({ service: "svc-x", env: "test", level: "info" }, stream);

    log.info({ event: "worker_started" }, "hello");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      service: "svc-x",
      env: "test",
      event: "worker_started",
      msg: "hello",
    });
  });

  it("redacts secret fields so they never reach the log sink (§21)", () => {
    const { lines, stream } = captureSink();
    const log = createLogger({ service: "svc-x", env: "test", level: "info" }, stream);

    log.info({
      openaiApiKey: "sk-should-not-appear",
      livekitApiSecret: "secret-should-not-appear",
      awsSecretAccessKey: "aws-should-not-appear",
      authorization: "Bearer tok-should-not-appear",
      safeField: "visible",
    });

    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain("should-not-appear");
    expect(lines[0]?.safeField).toBe("visible");
  });

  it("honors the configured level (debug suppressed at info)", () => {
    const { lines, stream } = captureSink();
    const log = createLogger({ service: "svc-x", env: "test", level: "info" }, stream);

    log.debug("suppressed");
    log.info("shown");

    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe("shown");
  });
});
