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

# Run as non-root.
USER node

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json

# Monitoring API port for K8s probes (§20).
EXPOSE 8080

# Exec form so SIGTERM reaches Node for graceful draining (§19).
CMD ["node", "dist/main.js"]
