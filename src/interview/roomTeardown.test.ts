import { describe, expect, it, vi } from "vitest";
import { deleteRoomBestEffort, type RoomDeleter } from "./roomTeardown.js";

const CREDS = {
  livekitUrl: "wss://livekit.test",
  livekitApiKey: "key",
  livekitApiSecret: "secret",
};

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("deleteRoomBestEffort", () => {
  it("deletes the room through a client built from the https-rewritten URL", async () => {
    const deleteRoom = vi.fn(async () => undefined);
    const clientFactory = vi.fn((): RoomDeleter => ({ deleteRoom }) as unknown as RoomDeleter);

    const outcome = await deleteRoomBestEffort({
      roomName: "mock-interview-1",
      ...CREDS,
      log: fakeLog(),
      clientFactory,
    });

    expect(outcome).toBe("deleted");
    expect(clientFactory).toHaveBeenCalledWith("https://livekit.test", "key", "secret");
    expect(deleteRoom).toHaveBeenCalledWith("mock-interview-1");
  });

  it("skips without building a client when credentials are missing", async () => {
    const clientFactory = vi.fn();

    const outcome = await deleteRoomBestEffort({
      roomName: "mock-interview-1",
      livekitUrl: undefined,
      livekitApiKey: "key",
      livekitApiSecret: "secret",
      log: fakeLog(),
      clientFactory,
    });

    expect(outcome).toBe("skipped");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("treats a twirp not_found as already_closed", async () => {
    const deleteRoom = vi.fn(async () => {
      throw new Error("twirp error not_found: requested room does not exist");
    });

    const outcome = await deleteRoomBestEffort({
      roomName: "mock-interview-1",
      ...CREDS,
      log: fakeLog(),
      clientFactory: () => ({ deleteRoom }) as unknown as RoomDeleter,
    });

    expect(outcome).toBe("already_closed");
  });

  it("never throws on transport errors — reports failed", async () => {
    // Teardown must not break job finalization (recording stop, webhook).
    const deleteRoom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const log = fakeLog();

    const outcome = await deleteRoomBestEffort({
      roomName: "mock-interview-1",
      ...CREDS,
      log,
      clientFactory: () => ({ deleteRoom }) as unknown as RoomDeleter,
    });

    expect(outcome).toBe("failed");
    expect(log.warn).toHaveBeenCalled();
  });
});
