import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbWrite } from './db';

// 🔴 Every read of "ProfilePictureHold" is here, on dbWrite: no read-replica role is granted the
// table, so a read-replica query naming it fails with a permission error and takes its page down.

/** Which of `imageIds` are a removed profile picture: one the sync job took off its user. */
export async function heldProfilePictureImageIds(
  imageIds: number[],
  db: Kysely<DB> = dbWrite
): Promise<Set<number>> {
  if (!imageIds.length) return new Set();
  const rows = await db
    .selectFrom('ProfilePictureHold')
    .select('imageId')
    .where('imageId', 'in', imageIds)
    .execute();
  return new Set(rows.map((r) => r.imageId));
}

/** `isProfilePicture` is the live pointer only; a removed profile picture is still one. */
export async function withHeldProfilePictures<T extends { id: number; isProfilePicture: boolean }>(
  rows: T[]
): Promise<T[]> {
  const held = await heldProfilePictureImageIds(
    rows.filter((r) => !r.isProfilePicture).map((r) => r.id)
  );
  if (!held.size) return rows;
  return rows.map((r) => (held.has(r.id) ? { ...r, isProfilePicture: true } : r));
}

/** The users with a record for any of `imageIds`. */
export async function heldProfilePictureUserIds(
  imageIds: number[],
  db: Kysely<DB> = dbWrite
): Promise<number[]> {
  if (!imageIds.length) return [];
  const rows = await db
    .selectFrom('ProfilePictureHold')
    .select('userId')
    .distinct()
    .where('imageId', 'in', imageIds)
    .execute();
  return rows.map((r) => r.userId);
}

export type HeldProfilePicture = {
  id: number;
  url: string;
  type: string;
  nsfwLevel: number;
  minor: boolean;
  acceptableMinor: boolean;
};

/**
 * Each user's newest removed profile picture: what their avatar was before the sync job took it. A
 * user whose newest record's image has since been purged has none.
 */
export async function latestHeldProfilePictures(
  userIds: number[],
  db: Kysely<DB> = dbWrite
): Promise<Map<number, HeldProfilePicture>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .selectFrom('ProfilePictureHold as h')
    .leftJoin('Image as i', 'i.id', 'h.imageId')
    .distinctOn('h.userId')
    .select([
      'h.userId',
      'i.id',
      'i.url',
      sql<string>`i.type::text`.as('type'),
      'i.nsfwLevel',
      'i.minor',
      'i.acceptableMinor',
    ])
    .where('h.userId', 'in', userIds)
    .orderBy('h.userId')
    .orderBy('h.createdAt', 'desc')
    .orderBy('h.id', 'desc')
    .execute();
  const held = new Map<number, HeldProfilePicture>();
  for (const { userId, id, url, type, nsfwLevel, minor, acceptableMinor } of rows) {
    if (id === null || url === null || nsfwLevel === null || minor === null) continue;
    held.set(userId, { id, url, type, nsfwLevel, minor, acceptableMinor: !!acceptableMinor });
  }
  return held;
}
