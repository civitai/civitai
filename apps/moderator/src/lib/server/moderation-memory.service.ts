import { getModeratorDb } from './moderator-db';
import { dbRead } from './db';
import { LEGACY_STRIKE_MARKER, legacyStrikeId } from '$lib/legacy-strike-import';
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

/**
 * Legacy ids that have ALREADY been copied into the main store by `migrate-legacy-strikes.ts`.
 *
 * `strikeCountsByUserIds` subtracts these so a strike is counted on exactly one side: it spans both
 * stores, and the import moved every row across on 2026-08-21 without a deploy behind it. Kept rather
 * than assumed-empty because the migration doc documents a rollback, which would put rows back.
 */
async function importedLegacyIds(userIds: number[]): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  const rows = await dbRead
    .selectFrom('UserStrike')
    .select('internalNotes')
    .where('userId', 'in', userIds)
    .where('internalNotes', 'like', `${LEGACY_STRIKE_MARKER}%`)
    .execute();

  return new Set(
    rows.flatMap((r) => {
      const id = legacyStrikeId(r.internalNotes);
      return id === null ? [] : [id];
    })
  );
}

/**
 * Strike counts for a SET of accounts (Retool's SimilarIpStrikes), for the linked-account lists. Empty
 * in / empty out, and accounts with no strikes are absent from the map rather than present as 0.
 *
 * 🔴 This spans BOTH stores, and it has to. Its consumers — the shared-IP and shared-link panels — are
 * the only place their number appears: they render `{#if acct.strikes > 0}` and have no `getLiveStrikes`
 * beside them, unlike the strike panels. Counting the legacy table alone made a struck alt read as clean
 * the moment the import moved its rows, and under-reported every strike issued since the cutover even
 * before that.
 *
 * Legacy rows are counted by id rather than with `count(*)` because the imported ones have to come off
 * the total and an aggregate cannot tell which rows they were.
 */
export async function strikeCountsByUserIds(ids: number[]): Promise<Map<number, number>> {
  const unique = [...new Set(ids)].filter(isInt4Id);
  if (!unique.length) return new Map();

  const [legacy, live, imported] = await Promise.all([
    getModeratorDb()
      .selectFrom('UserStrikes')
      .select(['id', 'userId'])
      .where('userId', 'in', unique)
      .execute(),
    dbRead
      .selectFrom('UserStrike')
      .select((eb) => ['userId', eb.fn.countAll<string>().as('count')])
      .where('userId', 'in', unique)
      .groupBy('userId')
      .execute(),
    importedLegacyIds(unique),
  ]);

  const counts = new Map<number, number>();
  for (const row of live) counts.set(row.userId, Number(row.count));
  for (const row of legacy) {
    if (row.userId === null || imported.has(row.id)) continue;
    counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
  }
  return counts;
}

// A moderator-authored notification (Retool's SendNotification, which POSTed the main app's
// /api/mod/send-mod-notification). Sent through the same client the strike path uses — the main-app
// endpoint only forwards to this service, so going direct removes a hop and one more place the
// payload shape can drift.

/** Where a moderator warning sends the user when the caller names no destination. The content-policy
 *  page is the main app's own answer to "why was I contacted" — it is what the footer, image detail
 *  and training upload all link to, and what Retool sent. */
const MOD_NOTIFICATION_URL = '/safety';
export async function sendModNotification(input: {
  userId: number;
  message: string;
  /** `system-announcement` renders this as the click-through; without one the notification is dead text. */
  url?: string;
  moderatorId: number;
}): Promise<ActionResult> {
  const url = input.url ?? MOD_NOTIFICATION_URL;
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
      details: { message: input.message, url },
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
