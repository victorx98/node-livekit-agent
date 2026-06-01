import { describe, it, expect, vi } from "vitest";
import { ContextManager, type ManagedSession, type SessionOutcome } from "./contextManager.js";
import type { ReseedSeed } from "./reseed.js";

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A fake session whose outcome is scripted. `startError` simulates a session
 * that throws during start (treated as a failure). */
function fakeSession(
  outcome: SessionOutcome,
  startError?: Error,
): ManagedSession & { start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => {
      if (startError) throw startError;
    }),
    done: vi.fn(async () => outcome),
    close: vi.fn(async () => {}),
  };
}

function makeManager(
  sessions: ManagedSession[],
  opts: { maxReconnects?: number } = {},
): {
  manager: ContextManager;
  createSession: ReturnType<typeof vi.fn>;
  onReconnect: ReturnType<typeof vi.fn>;
  seeds: ReseedSeed[];
  reseedFlags: boolean[];
} {
  const seeds: ReseedSeed[] = [];
  const reseedFlags: boolean[] = [];
  let i = 0;

  const buildSeed = (isReseed: boolean): ReseedSeed => {
    reseedFlags.push(isReseed);
    const seed: ReseedSeed = isReseed
      ? { instructions: "INSTR", recap: "RECAP" }
      : { instructions: "INSTR" };
    seeds.push(seed);
    return seed;
  };

  const createSession = vi.fn(async (_seed: ReseedSeed) => {
    const s = sessions[i];
    i += 1;
    if (!s) throw new Error("test ran out of scripted sessions");
    return s;
  });

  const onReconnect = vi.fn(async (_attempt: number) => {});

  const manager = new ContextManager({
    buildSeed,
    createSession,
    onReconnect,
    maxReconnects: opts.maxReconnects ?? 3,
    log: noopLog,
  });

  return { manager, createSession, onReconnect, seeds, reseedFlags };
}

describe("ContextManager — reconnect + reseed loop", () => {
  it("runs a single session to normal completion without reconnecting", async () => {
    const s = fakeSession({ kind: "ended" });
    const { manager, createSession, onReconnect, reseedFlags } = makeManager([s]);

    await manager.run();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(reseedFlags).toEqual([false]); // first seed is not a reseed
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("reconnects and reseeds after fatal failures, then continues", async () => {
    const sessions = [
      fakeSession({ kind: "failed", error: new Error("socket gone") }),
      fakeSession({ kind: "failed", error: new Error("socket gone again") }),
      fakeSession({ kind: "ended" }),
    ];
    const { manager, createSession, onReconnect, seeds, reseedFlags } = makeManager(sessions, {
      maxReconnects: 3,
    });

    await manager.run();

    expect(createSession).toHaveBeenCalledTimes(3);
    // attempt 0 is a fresh start; attempts 1 and 2 are reseeds.
    expect(reseedFlags).toEqual([false, true, true]);
    expect(seeds[1]?.recap).toBe("RECAP");
    expect(seeds[2]?.recap).toBe("RECAP");
    // onReconnect fires once per retry with the attempt number.
    expect(onReconnect.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it("gives up and throws after exhausting the reconnect cap", async () => {
    const sessions = [
      fakeSession({ kind: "failed", error: new Error("x") }),
      fakeSession({ kind: "failed", error: new Error("x") }),
      fakeSession({ kind: "failed", error: new Error("x") }),
    ];
    const { manager, createSession, onReconnect } = makeManager(sessions, { maxReconnects: 2 });

    await expect(manager.run()).rejects.toThrow(/reconnect attempts exhausted/i);
    // initial attempt + 2 reconnect attempts
    expect(createSession).toHaveBeenCalledTimes(3);
    expect(onReconnect.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it("treats a session that throws on start as a failure and retries", async () => {
    const sessions = [
      fakeSession({ kind: "ended" }, new Error("start blew up")),
      fakeSession({ kind: "ended" }),
    ];
    const { manager, createSession } = makeManager(sessions, { maxReconnects: 1 });

    await manager.run();

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1); // failed session still closed
  });
});
