import { getModeratorDb } from './moderator-db';
import { getNotifications } from './notifications';
import { recordModActivity } from './mod-activity';
import { isInt4Id } from './users.service';
import type { ActionResult } from './user-actions.service';

// Moderation memory — notes and strikes about a user (Retool's SelectUserNotes / UserStrikes, ticket
// §1.2 "mod notes" and "strike account"). This is the first slice served from the MODERATOR database
// rather than the main one; everything here goes through `getModeratorDb()`.
//
// Attribution is by NAME, not id: `lastUpdateBy`/`createdBy` are free text holding Retool display names
// on historical rows. New rows written here use the moderator's Civitai username, which is resolvable;
// the backfill that maps the old names to ids is a separate, deferred migration. Until it lands the
// column holds two naming schemes, which is why nothing joins on it.
//
// Neither table is indexed on `userId` (56k notes, 12.7k strikes), so these are small seq scans —
// fine at this size, worth an index if either grows.

export type UserNote = {
  id: number;
  notes: string | null;
  lastUpdate: Date | null;
  lastUpdateBy: string | null;
  /** True when the viewing moderator wrote it and may therefore edit it. */
  isMine: boolean;
};

export type UserStrike = {
  id: number;
  reason: string | null;
  createdAt: Date | null;
  createdBy: string | null;
};

export async function getUserNotes(userId: number, viewer: string | null): Promise<UserNote[]> {
  const rows = await getModeratorDb()
    .selectFrom('UserNotes')
    .select(['id', 'notes', 'lastUpdate', 'lastUpdateBy'])
    .where('userId', '=', userId)
    .orderBy('lastUpdate', 'desc')
    .execute();
  return rows.map((r) => ({ ...r, isMine: !!viewer && r.lastUpdateBy === viewer }));
}

// Account-level moderation flags, stored per NOTE row but meaning something about the account. Any row
// carrying the flag sets it — a moderator who whitelisted this account did so regardless of which of
// their notes the write landed on.
export type ModerationFlags = { spamWhitelist: boolean; deservedMute: boolean };

export async function getModerationFlags(userId: number): Promise<ModerationFlags> {
  const rows = await getModeratorDb()
    .selectFrom('UserNotes')
    .select(['spamWhitelist', 'deservedMute'])
    .where('userId', '=', userId)
    .execute();
  return {
    spamWhitelist: rows.some((r) => r.spamWhitelist === true),
    deservedMute: rows.some((r) => r.deservedMute === true),
  };
}

export async function getUserStrikes(userId: number): Promise<UserStrike[]> {
  return getModeratorDb()
    .selectFrom('UserStrikes')
    .select(['id', 'reason', 'createdAt', 'createdBy'])
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .execute();
}

// Strike counts for a SET of accounts (Retool's SimilarIpStrikes), for the linked-account lists. Empty
// in / empty out, and accounts with no strikes are absent from the map rather than present as 0.
export async function strikeCountsByUserIds(ids: number[]): Promise<Map<number, number>> {
  const unique = [...new Set(ids)].filter(isInt4Id);
  if (!unique.length) return new Map();

  const rows = await getModeratorDb()
    .selectFrom('UserStrikes')
    .select((eb) => ['userId', eb.fn.countAll<string>().as('count')])
    .where('userId', 'in', unique)
    .groupBy('userId')
    .execute();
  return new Map(rows.flatMap((r) => (r.userId === null ? [] : [[r.userId, Number(r.count)]])));
}

// ISSUING A STRIKE (Retool's InsertStrike + InsertStrikeNotif + LogStrike).
//
// Two systems, and they can disagree: the strike row lives in the MODERATOR database while the
// notification goes to the notifications service over HTTP. The row is written first and the
// notification is best-effort — a strike that is recorded but not announced is recoverable, whereas a
// user told they were struck with no row behind it is not. The caller is told which happened.
export type StrikeResult = { ok: true; notified: boolean } | { ok: false; error: string };

export async function addUserStrike(input: {
  userId: number;
  reason: string;
  author: string;
  moderatorId: number;
}): Promise<StrikeResult> {
  const row = await getModeratorDb()
    .insertInto('UserStrikes')
    .values({
      userId: input.userId,
      reason: input.reason,
      createdBy: input.author,
      createdAt: new Date(),
    })
    .returning('id')
    .executeTakeFirst();

  if (!row) return { ok: false, error: 'Could not record the strike.' };

  await recordModActivity({
    userId: input.moderatorId,
    entityType: 'user',
    entityId: input.userId,
    activity: 'strike',
  });

  let notified = false;
  try {
    await getNotifications().createNotification({
      // The strike id keys the notification, so a retry cannot deliver a second copy of the same one.
      key: `moderator-strike:${row.id}`,
      userId: input.userId,
      type: 'system-announcement',
      category: 'System',
      details: {
        message: `A moderator issued a strike on your account: ${input.reason}`,
        // Retool's strike notification linked here; `system-announcement` renders `url` as the
        // click-through, so omitting it leaves the user told but with nowhere to go.
        url: '/safety',
      },
    });
    notified = true;
  } catch (e) {
    console.error('[moderation-memory] strike notification failed', e);
  }

  return { ok: true, notified };
}

// A moderator-authored notification (Retool's SendNotification, which POSTed the main app's
// /api/mod/send-mod-notification). Sent through the same client the strike path uses — the main-app
// endpoint only forwards to this service, so going direct removes a hop and one more place the
// payload shape can drift.
export async function sendModNotification(input: {
  userId: number;
  message: string;
  /** `system-announcement` renders this as the click-through. Without it the notification is dead
   *  text — Retool sent `/safety`, or `/generate` for its non-AI-content reason. */
  url?: string;
  moderatorId: number;
}): Promise<ActionResult> {
  try {
    await getNotifications().createNotification({
      // The minute bucket is what makes this a double-submit guard rather than a permanent one: keyed
      // on the message alone, a moderator could never send the same warning to the same user twice.
      key: `moderator-message:${input.moderatorId}:${input.userId}:${Math.floor(
        Date.now() / 60_000
      )}:${input.message.slice(0, 64)}`,
      userId: input.userId,
      type: 'system-announcement',
      category: 'System',
      details: { message: input.message, ...(input.url ? { url: input.url } : {}) },
    });
  } catch (e) {
    console.error('[moderation-memory] notification failed', e);
    return { ok: false, error: 'Could not send the notification.' };
  }

  await recordModActivity({
    userId: input.moderatorId,
    entityType: 'user',
    entityId: input.userId,
    activity: 'notify',
  });
  return { ok: true };
}

export async function addUserNote(input: {
  userId: number;
  notes: string;
  author: string;
}): Promise<void> {
  await getModeratorDb()
    .insertInto('UserNotes')
    .values({
      userId: input.userId,
      notes: input.notes,
      lastUpdate: new Date(),
      lastUpdateBy: input.author,
    })
    .execute();
}

// The `lastUpdateBy` predicate is the authorisation check, not just a filter — a forged id changes
// nothing. Because it matches on a NAME, a historical row written under a Retool display name is
// editable by whoever holds that Civitai username; the id backfill closes that.
export async function updateUserNote(input: {
  id: number;
  notes: string;
  author: string;
}): Promise<boolean> {
  const result = await getModeratorDb()
    .updateTable('UserNotes')
    .set({ notes: input.notes, lastUpdate: new Date() })
    .where('id', '=', input.id)
    .where('lastUpdateBy', '=', input.author)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}
