import { getModeratorDb } from './moderator-db';
import { isInt4Id } from './users.service';

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
