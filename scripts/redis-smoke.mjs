// Integration smoke test for the Phase 2 durable-state layer against a REAL
// Redis (not the in-memory mock). Exercises RedisStore + RedisJobTracker the
// same way agent.ts does, then prints what landed in Redis.
//
// Usage: REDIS_URL=redis://localhost:6399 node scripts/redis-smoke.mjs

import { Redis } from "ioredis";
import { RedisStore } from "../dist/state/redisStore.js";
import { RedisJobTracker } from "../dist/ops/jobTracker.js";
import { createInitialState, appendTurn } from "../dist/interview/interviewState.js";

const url = process.env.REDIS_URL ?? "redis://localhost:6399";
const redis = new Redis(url);
const store = new RedisStore(redis);
const tracker = new RedisJobTracker(store);

const jobId = "smoke_job_1";
const interviewId = "smoke_int_1";
const room = "smoke-room";
const now = new Date().toISOString();

await tracker.create(jobId, {
  room,
  provider: "openai",
  model: "gpt-realtime",
  status: "starting",
});

let state = createInitialState({ jobId, interviewId, now });
await store.saveInterviewState(state);

const turns = [
  ["interviewer", "Hi, tell me about a backend system you built."],
  ["candidate", "I built a payments service handling 2k req/s."],
  ["interviewer", "How did you handle retries?"],
  ["candidate", "Idempotency keys plus exponential backoff."],
];

for (const [role, text] of turns) {
  const at = new Date().toISOString();
  await store.appendTranscript({ jobId, interviewId, room, role, text, at });
  state = appendTurn(state, { role, text, at });
  await store.saveInterviewState(state);
  await tracker.update(jobId, {
    status: "in_progress",
    turns: state.stats.turns,
    lastActivityAt: at,
  });
}

const persistedState = await store.getInterviewState(jobId);
const transcript = await store.getTranscript(jobId);
const job = await tracker.get(jobId);

console.log("\n=== Job record ===");
console.log(JSON.stringify(job, null, 2));
console.log("\n=== InterviewState (turns:", persistedState.stats.turns, ") ===");
console.log(
  JSON.stringify(
    { ...persistedState, recentTurns: persistedState.recentTurns.length + " turns" },
    null,
    2,
  ),
);
console.log("\n=== Transcript (", transcript.length, "events) ===");
for (const e of transcript) console.log(`  #${e.sequence} ${e.role}: ${e.text}`);

console.log("\n=== Raw Redis keys ===");
const keys = await redis.keys("*");
console.log(keys.sort().join("\n"));

await redis.quit();
