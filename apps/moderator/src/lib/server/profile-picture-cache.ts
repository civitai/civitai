import { REDIS_KEYS } from '@civitai/redis';
import { logAxiomError } from './axiom';
import { bustCachedObject } from './cache';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbWrite } from './db';
import { heldProfilePictureUserIds } from './profile-picture-hold';

/**
 * The users whose profile picture is one of `imageIds`, or was until the sync job removed it. Read
 * before a delete: the relation is set null.
 */
export async function profilePictureUserIds(
  imageIds: number[],
  db: Kysely<DB> = dbWrite
): Promise<number[]> {
  if (!imageIds.length) return [];
  const [rows, held] = await Promise.all([
    db.selectFrom('User').select('id').where('profilePictureId', 'in', imageIds).execute(),
    heldProfilePictureUserIds(imageIds, db),
  ]);
  return [...new Set([...rows.map((x) => x.id), ...held])];
}

// The main app caches each user's profile picture for a day, and avatars are shown or hidden on its
// rating. Never throws: it follows a committed moderation write.
export async function bustProfilePictures(
  target: { imageIds: number[] } | { userIds: number[] }
): Promise<void> {
  try {
    const userIds =
      'userIds' in target ? target.userIds : await profilePictureUserIds(target.imageIds);
    await bustCachedObject(REDIS_KEYS.CACHES.PROFILE_PICTURES, userIds);
  } catch (error) {
    void logAxiomError(error, { event: 'profile-picture-cache-bust' });
  }
}
