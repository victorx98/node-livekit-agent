import { EventEmitter } from "node:events";
import { DisconnectReason, RoomEvent, type RemoteParticipant, type Room } from "@livekit/rtc-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateIdentityFromParticipantId,
  watchInterviewEnd,
  type InterviewEndReason,
} from "./roomEndWatcher.js";

const candidateIdentity = "student-3dd2084c-a379-43c4-b1ca-f8b4d132f652";

class FakeRoom extends EventEmitter {
  remoteParticipants = new Map<string, RemoteParticipant>();

  connectParticipant(identity: string): RemoteParticipant {
    const participant = { identity } as RemoteParticipant;
    this.remoteParticipants.set(identity, participant);
    this.emit(RoomEvent.ParticipantConnected, participant);
    return participant;
  }

  disconnectParticipant(identity: string, disconnectReason?: DisconnectReason): void {
    const participant =
      this.remoteParticipants.get(identity) ??
      ({
        identity,
      } as RemoteParticipant);
    this.remoteParticipants.delete(identity);
    Object.defineProperty(participant, "disconnectReason", {
      configurable: true,
      value: disconnectReason,
    });
    this.emit(RoomEvent.ParticipantDisconnected, participant);
  }

  disconnectRoom(disconnectReason: DisconnectReason): void {
    this.emit(RoomEvent.Disconnected, disconnectReason);
  }
}

function watch(room: FakeRoom, overrides: Partial<Parameters<typeof watchInterviewEnd>[0]> = {}) {
  return watchInterviewEnd({
    room: room as unknown as Pick<Room, "remoteParticipants" | "on" | "off">,
    durationMinutes: 30,
    candidateIdentity,
    absenceGraceMs: 15_000,
    ...overrides,
  });
}

async function isPending(promise: Promise<InterviewEndReason>): Promise<boolean> {
  const pending = Symbol("pending");
  const result = await Promise.race([promise, Promise.resolve(pending)]);
  return result === pending;
}

describe("candidateIdentityFromParticipantId", () => {
  it("matches the API token identity format", () => {
    expect(candidateIdentityFromParticipantId("student-id")).toBe("student-student-id");
  });
});

describe("watchInterviewEnd", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the duration ceiling is reached", async () => {
    const room = new FakeRoom();
    const ended = watch(room, { durationMinutes: 1 / 60_000 });

    await vi.advanceTimersByTimeAsync(1);

    await expect(ended).resolves.toEqual({
      kind: "duration_timeout",
      durationMinutes: 1 / 60_000,
    });
  });

  it("lets a 60-minute interview run the full 60 minutes (regression: 59 clamp)", async () => {
    const room = new FakeRoom();
    const ended = watch(room, { durationMinutes: 60 });

    // One millisecond before the 60-minute mark: still running.
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(await isPending(ended)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await expect(ended).resolves.toEqual({ kind: "duration_timeout", durationMinutes: 60 });
  });

  it("clamps oversized durations to the 60-minute ceiling", async () => {
    const room = new FakeRoom();
    const ended = watch(room, { durationMinutes: 90 });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(ended).resolves.toEqual({ kind: "duration_timeout", durationMinutes: 90 });
  });

  it("resolves immediately when the room disconnects", async () => {
    const room = new FakeRoom();
    const ended = watch(room);

    room.disconnectRoom(DisconnectReason.ROOM_CLOSED);

    await expect(ended).resolves.toEqual({
      kind: "room_disconnected",
      disconnectReason: "ROOM_CLOSED",
      disconnectReasonCode: DisconnectReason.ROOM_CLOSED,
    });
  });

  it("waits for the grace window before ending after the candidate leaves", async () => {
    const room = new FakeRoom();
    room.connectParticipant(candidateIdentity);
    const ended = watch(room);

    room.disconnectParticipant(candidateIdentity, DisconnectReason.CLIENT_INITIATED);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(await isPending(ended)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);

    await expect(ended).resolves.toEqual({
      kind: "candidate_absent",
      participantIdentity: candidateIdentity,
      absenceGraceMs: 15_000,
      disconnectReason: "CLIENT_INITIATED",
      disconnectReasonCode: DisconnectReason.CLIENT_INITIATED,
    });
  });

  it("keeps the interview alive when a duplicate-identity reconnect arrives within grace", async () => {
    const room = new FakeRoom();
    room.connectParticipant(candidateIdentity);
    const ended = watch(room);

    room.disconnectParticipant(candidateIdentity, DisconnectReason.DUPLICATE_IDENTITY);
    await vi.advanceTimersByTimeAsync(5_000);
    room.connectParticipant(candidateIdentity);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await isPending(ended)).toBe(true);
  });

  it("ignores non-candidate participant disconnects", async () => {
    const room = new FakeRoom();
    room.connectParticipant(candidateIdentity);
    room.connectParticipant("EG_hkjYVzNg242e");
    const ended = watch(room);

    room.disconnectParticipant("EG_hkjYVzNg242e", DisconnectReason.CONNECTION_TIMEOUT);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await isPending(ended)).toBe(true);
  });
});
