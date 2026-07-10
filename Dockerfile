# syntax=docker/dockerfile:1
# Based on the LiveKit agents-js reference production Dockerfile (§18).

# ---- builder ----
FROM node:22-slim AS builder
WORKDIR /app

# Enable pnpm via corepack (pinned by package.json "packageManager").
RUN corepack enable

# Install deps with the lockfile for reproducible builds.
# pnpm-workspace.yaml carries the build-script allowlist (esbuild) for pnpm 11+.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

# Build TypeScript -> dist/.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Drop dev dependencies for the runtime image.
RUN pnpm prune --prod

# ---- runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The @livekit/rtc-node native engine validates TLS against the OS trust store
# (Node's own bundled CAs cover the JS layer only). node:22-slim ships without
# it, so the room-connect region-info fetch fails its TLS handshake and every
# job dies with "failed to retrieve region info". Install the CA bundle.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Run as non-root.
USER node

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json

# Ports (§20): 8080 = our monitoring API (K8s probes + control plane);
# 8081 = the LiveKit framework's built-in health/worker server.
EXPOSE 8080 8081

# Container-level healthcheck against the monitoring API (K8s uses its own
# probes; this helps `docker run`). No curl in slim, so use Node's http client.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MONITORING_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Exec form so SIGTERM reaches Node for graceful draining (§19).
# "start" runs the LiveKit worker in production mode.
CMD ["node", "dist/main.js", "start"]
