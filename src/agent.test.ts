import { describe, expect, it } from "vitest";
import { resolveAssignedRoomName } from "./agent.js";

describe("resolveAssignedRoomName", () => {
  it("uses the LiveKit job room name before the connected room is populated", () => {
    expect(
      resolveAssignedRoomName({
        job: { room: { name: "assigned-room" } },
        room: {},
      }),
    ).toBe("assigned-room");
  });

  it("falls back to the connected room name when job room metadata is absent", () => {
    expect(
      resolveAssignedRoomName({
        job: {},
        room: { name: "connected-room" },
      }),
    ).toBe("connected-room");
  });

  it("fails with context when LiveKit does not expose a room name", () => {
    expect(() =>
      resolveAssignedRoomName({
        job: { id: "AJ_missing_room" },
        room: {},
      }),
    ).toThrow("Cannot resolve LiveKit room name for job AJ_missing_room");
  });
});
