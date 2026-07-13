import {
  DisconnectReason,
  RoomEvent,
  type RemoteParticipant,
  type Room,
} from "@livekit/rtc-node";
import type { Logger } from "pino";

export type InterviewEndReason =
  | {
      kind: "duration_timeout";
      durationMinutes: number;
    }
  | {
      kind: "room_disconnected";
      disconnectReason?: string;
      disconnectReasonCode?: DisconnectReason;
    }
  | {
      kind: "candidate_absent";
      participantIdentity: string;
      absenceGraceMs: number;
      disconnectReason?: string;
      disconnectReasonCode?: DisconnectReason;
    };

export interface WatchInterviewEndOptions {
  room: Pick<Room, "remoteParticipants" | "on" | "off">;
  durationMinutes: number;
  candidateIdentity: string;
  absenceGraceMs: number;
  log?: Pick<Logger, "info">;
}

export function candidateIdentityFromParticipantId(participantId: string): string {
  return `student-${participantId}`;
}

export function watchInterviewEnd({
  room,
  durationMinutes,
  candidateIdentity,
  absenceGraceMs,
  log,
}: WatchInterviewEndOptions): Promise<InterviewEndReason> {
  // Ceiling 60: the longest bookable interview type is 60 minutes; the old
  // 59 clamp silently cut a 60-minute session short by a minute.
  const maxMs = Math.min(durationMinutes, 60) * 60_000;

  return new Promise<InterviewEndReason>((resolve) => {
    let settled = false;
    let candidateAbsenceTimer: ReturnType<typeof setTimeout> | undefined;

    const clearCandidateAbsenceTimer = (): void => {
      if (candidateAbsenceTimer === undefined) return;
      clearTimeout(candidateAbsenceTimer);
      candidateAbsenceTimer = undefined;
    };

    const finish = (reason: InterviewEndReason): void => {
      if (settled) return;
      settled = true;
      clearTimeout(durationTimer);
      clearCandidateAbsenceTimer();
      room.off(RoomEvent.Disconnected, onRoomDisconnected);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      resolve(reason);
    };

    const durationTimer = setTimeout(() => {
      finish({ kind: "duration_timeout", durationMinutes });
    }, maxMs);

    const onRoomDisconnected = (reason?: DisconnectReason): void => {
      finish({
        kind: "room_disconnected",
        disconnectReason: disconnectReasonName(reason),
        disconnectReasonCode: reason,
      });
    };

    const onParticipantDisconnected = (participant: RemoteParticipant): void => {
      if (participant.identity !== candidateIdentity) return;

      const disconnectReason = disconnectReasonName(participant.disconnectReason);
      log?.info(
        {
          event: "candidate_participant_disconnected",
          participant_identity: participant.identity,
          disconnect_reason: disconnectReason,
          disconnect_reason_code: participant.disconnectReason,
          absence_grace_ms: absenceGraceMs,
          remote_participants: room.remoteParticipants.size,
        },
        "candidate participant disconnected; waiting for reconnect grace",
      );

      clearCandidateAbsenceTimer();
      candidateAbsenceTimer = setTimeout(() => {
        candidateAbsenceTimer = undefined;
        if (hasParticipant(room, candidateIdentity)) return;
        finish({
          kind: "candidate_absent",
          participantIdentity: participant.identity,
          absenceGraceMs,
          disconnectReason,
          disconnectReasonCode: participant.disconnectReason,
        });
      }, absenceGraceMs);
    };

    const onParticipantConnected = (participant: RemoteParticipant): void => {
      if (participant.identity !== candidateIdentity || candidateAbsenceTimer === undefined) {
        return;
      }

      clearCandidateAbsenceTimer();
      log?.info(
        {
          event: "candidate_rejoined_before_end",
          participant_identity: participant.identity,
          absence_grace_ms: absenceGraceMs,
          remote_participants: room.remoteParticipants.size,
        },
        "candidate rejoined before reconnect grace expired",
      );
    };

    room.on(RoomEvent.Disconnected, onRoomDisconnected);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  });
}

function hasParticipant(
  room: Pick<Room, "remoteParticipants">,
  participantIdentity: string,
): boolean {
  if (room.remoteParticipants.has(participantIdentity)) return true;

  for (const participant of room.remoteParticipants.values()) {
    if (participant.identity === participantIdentity) return true;
  }

  return false;
}

function disconnectReasonName(reason: DisconnectReason | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return DisconnectReason[reason] ?? String(reason);
}
