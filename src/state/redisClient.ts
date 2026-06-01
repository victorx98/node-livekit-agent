import { Redis } from "ioredis";

// Lazy, process-wide ioredis connection (§14). Created on first use so importing
// modules that reference Redis does not force a connection (keeps tests and
// non-Redis code paths free of side effects). A LiveKit child process may handle
// several jobs over its lifetime, so the connection is reused, not per-job.

let client: Redis | undefined;

export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL is required for durable state (Phase 2).");
    }
    // lazyConnect: connect on first command rather than at construction.
    client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
