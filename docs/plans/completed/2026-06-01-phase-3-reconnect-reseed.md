# Phase 3 — Reconnect + Reseed

Status: completed
Owner: agent
Phase: README status "Phase 3"

## Outcome

Implemented test-first. The reconnect loop is proven by a deliberate
fault-injection unit test (fake session factory fails N times → reseeds, counts
reconnects, gives up after the cap), and `buildReseedContext` is unit-tested
pure. 98 tests pass; `pnpm verify` green. Live fatal-disconnect reseed is the
operator's acceptance step (needs credentials); transient drops are handled by
the OpenAI plugin itself.

## Goal

Guarantee "never lose context": when a realtime session fails fatally, open a
new session and reseed it from the persisted Redis state (§13). Keep the
duration cap and the `assertProviderAllowed` Gemini gate (§11, §15).

## What the framework already does (verified against installed packages)

- `@livekit/agents-plugin-openai` auto-reconnects transient WebSocket drops and
  replays its in-memory chat context (conversation restored as text). So a
  killed socket recovers with context without our help.
- It retries `connOptions.maxRetry` (default 3) times; on exhaustion it emits a
  non-recoverable error, and `AgentSession` closes itself with
  `CloseReason.ERROR`.

Phase 3 therefore handles the *fatal* path the framework cannot: rebuild a fresh
session and reseed it from our durable Redis recap, up to a retry cap.

## Verification (acceptance)

- Deliberate fault-injection unit test: a `ContextManager` driven by a fake
  session factory that fails N times then ends — assert it reconnects, reseeds
  (recap carried), increments reconnects, and gives up after the cap.
- Live: force a disconnect mid-interview; the plugin reconnects transient drops;
  a fatal close triggers our reseed and the agent continues from the recap.

## Module plan

- `src/interview/reseed.ts` (pure): `ReseedSeed` + `buildReseedContext(cfg,
  state, isReseed)` — full §12 instructions, plus a recap (covered questions,
  current index, still-to-cover, recent turns) on reseed. No Redis, no LiveKit.
- `src/interview/contextManager.ts`: `ContextManager` reconnect controller.
  Depends only on injected effects — `buildSeed`, `createSession` factory,
  `onReconnect` callback — so the loop is unit-testable with fault injection.
  Includes a no-op rotation hook (deferred, §13).
- `src/config/env.ts`: add `reconnectMaxRetries` (env `RECONNECT_MAX_RETRIES`,
  default 3).
- `src/agent.ts`: drive the session through `ContextManager`. `createSession`
  builds a `voice.AgentSession`, captures turns (write-through, Phase 2), seeds
  instructions+recap, greets on first start / continues on reseed, and resolves
  its outcome on room end (`ended`) or `Close{reason: ERROR}` (`failed`). One
  interview-wide duration/room-end promise bounds the whole run.

## Test-first cases

- reseed (pure): first attempt → no recap; reseed → recap names covered/pending
  questions by text, current index, recent turns; reseed with no state is safe.
- contextManager (fault injection): clean first run; recovers after K failures
  (reconnects bumped, recap carried, onReconnect called per retry); exhausts cap
  then throws; a start() that throws is treated as a failure and retried.

## Out of scope

Proactive rotation (no-op hook only), recording, monitoring API, webhooks.
