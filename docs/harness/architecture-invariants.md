# Architecture Invariants

These rules keep the service legible as agents add features.

## Current Layering

```text
types -> config -> providers/interview/ops/state -> agent -> main
```

The arrows show allowed knowledge direction. Lower-level modules should not
import higher-level runtime modules. `providers`, `interview`, `ops`, and
`state` are peers; sibling imports are allowed but should stay minimal (e.g. the
Redis-backed job tracker in `ops` delegates persistence to `state/redisStore`).

## Boundary Rules

- `src/types/` defines shared contracts and must not import application logic.
- `src/config/resolveConfig.ts` is the only module that maps dispatch metadata
  into `ResolvedJobConfig`.
- `src/config/schema.ts` validates the wire contract at the boundary.
- Provider modules consume `ResolvedJobConfig`; they do not parse LiveKit job
  metadata directly.
- Interview prompt and state-model modules are pure: no LiveKit, no Redis.
  `interview/interviewState.ts` and `interview/transcriptStore.ts` define and
  reduce state; they must not perform I/O.
- `src/state/redisStore.ts` is the only module that issues Redis commands.
  `src/state/redisClient.ts` owns the lazy connection. Other modules depend on
  `RedisStore` methods, never on `ioredis` directly.
- `src/agent.ts` owns LiveKit job orchestration and should delegate parsing,
  prompt building, provider creation, state persistence, and job tracking to
  smaller modules.
- `src/main.ts` owns worker process startup and should not contain per-job
  interview behavior.
- Operational modules must keep structured logs and secret redaction intact.

## Dependency Guidance

Prefer dependencies that are easy for future agents to inspect and test. Add a
third-party package only when it removes meaningful complexity and its behavior
is clear from docs or tests.

## When To Promote A Rule

If an architectural rule is violated more than once, promote it from prose into
a mechanical check. Candidate checks include file-size limits, dependency
direction tests, schema naming conventions, and required structured log fields.
