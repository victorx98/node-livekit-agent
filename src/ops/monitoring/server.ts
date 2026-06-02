import { createServer, type Server } from "node:http";
import { dispatch, type MonitoringDeps } from "./handlers.js";

// Thin node:http binding for the monitoring API (§20). The framework runs its
// own health server on a different port (8081); this one (default 8080) exposes
// our readiness + job views for K8s probes and the control plane. All routing
// lives in the pure `dispatch`; this module only moves bytes. Built-in http
// keeps the dependency surface small (no Fastify).

export interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface MonitoringServerOptions {
  host: string;
  port: number;
  deps: MonitoringDeps;
  log: MinimalLogger;
}

export interface MonitoringServer {
  /** The bound port (resolved when port 0 is passed). */
  port: number;
  close(): Promise<void>;
}

export function startMonitoringServer(opts: MonitoringServerOptions): Promise<MonitoringServer> {
  const { host, port, deps, log } = opts;

  const server: Server = createServer((req, res) => {
    void handle();

    async function handle(): Promise<void> {
      try {
        const result = await dispatch(
          { method: req.method ?? "GET", path: req.url ?? "/" },
          deps,
        );
        const payload = JSON.stringify(result.body);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(payload);
      } catch (err) {
        // The tracker reads Redis; surface failures as 500 rather than hanging.
        log.error({ event: "monitoring_request_failed", err }, "monitoring request failed");
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  return new Promise<MonitoringServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      log.info({ event: "monitoring_server_started", host, port: boundPort }, "monitoring API up");
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
