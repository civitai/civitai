// The `/api/user-memory` payload, declared once for both the endpoint and the panel. Row shapes are
// DERIVED from the services', through `Jsonified` — same reasoning as the sibling `user-account.ts`,
// which has the worked example.

import type { Jsonified } from '$lib/format';
import type {
  ModerationFlags as ServerModerationFlags,
  UserNote,
} from '$lib/server/moderation-memory.service';
import type { LiveStrike as ServerLiveStrike } from '$lib/server/user-lookup.service';

export type Note = Jsonified<UserNote>;

/** A row from the main app's `UserStrike` — what "Issue strike" writes. */
export type LiveStrike = Jsonified<ServerLiveStrike>;

export type ModerationFlags = ServerModerationFlags;

export type Memory = {
  notes: Note[];
  /** `null` means the main database could not be reached — NOT that the account has no strikes. */
  liveStrikes: LiveStrike[] | null;
  flags: ModerationFlags;
};

export async function fetchMemory(userId: number, version: number): Promise<Memory> {
  const r = await fetch(`/api/user-memory/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
