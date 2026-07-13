import { RoomServiceClient } from "livekit-server-sdk";
import type { Logger } from "pino";

// Best-effort LiveKit room teardown after the interview ends.
//
// Why: the agent leaving the room does NOT close it. A zombie candidate
// connection (background tab, locked laptop) keeps the room occupied, so
// LiveKit's empty-timeout never fires and the room session can run for many
// hours after the interview logically ended. Deleting the room kicks every
// remaining participant and makes LiveKit emit `room_finished`, which the
// backend uses to converge the interview row.
//
// Error contract: never throws — teardown must not break job finalization
// (recording stop, Redis finalize, final webhook).

export type RoomTeardownOutcome = "deleted" | "already_closed" | "skipped" | "failed";

/** Minimal surface of RoomServiceClient used here; injectable for tests. */
export type RoomDeleter = Pick<RoomServiceClient, "deleteRoom">;

export interface DeleteRoomBestEffortOptions {
  roomName: string;
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  log?: Pick<Logger, "info" | "warn">;
  /** Test seam. Defaults to a real RoomServiceClient. */
  clientFactory?: (url: string, apiKey: string, apiSecret: string) => RoomDeleter;
}

/**
 * Delete a LiveKit room, tolerating every failure mode.
 *
 * @returns "deleted" on success, "already_closed" when the room no longer
 *          exists (normal after a clean disconnect), "skipped" when LiveKit
 *          credentials are not configured, "failed" on any other error.
 */
export async function deleteRoomBestEffort({
  roomName,
  livekitUrl,
  livekitApiKey,
  livekitApiSecret,
  log,
  clientFactory = (url, apiKey, apiSecret) => new RoomServiceClient(url, apiKey, apiSecret),
}: DeleteRoomBestEffortOptions): Promise<RoomTeardownOutcome> {
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
    log?.warn(
      { event: "room_teardown_skipped", room: roomName },
      "LiveKit credentials missing; cannot delete room",
    );
    return "skipped";
  }

  try {
    // RoomServiceClient speaks HTTP (Twirp); LIVEKIT_URL is the wss://
    // signalling URL, so rewrite the scheme (wss→https, ws→http).
    const httpUrl = livekitUrl.replace(/^ws/, "http");
    await clientFactory(httpUrl, livekitApiKey, livekitApiSecret).deleteRoom(roomName);
    log?.info({ event: "room_deleted", room: roomName }, "LiveKit room deleted");
    return "deleted";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A twirp not_found means the room already closed on its own — that is
    // the desired end state, not an error.
    if (/not[_ ]?found|does not exist/i.test(message)) {
      log?.info({ event: "room_already_closed", room: roomName }, "LiveKit room already closed");
      return "already_closed";
    }
    log?.warn({ event: "room_teardown_failed", room: roomName, err }, "failed to delete room");
    return "failed";
  }
}
