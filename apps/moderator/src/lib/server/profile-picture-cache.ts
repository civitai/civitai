import { REDIS_KEYS } from '@civitai/redis';
import { logAxiomError } from './axiom';
import { bustCachedObject } from './cache';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbWrite } from './db';

/** The users whose profile picture is one of `imageIds`. Read before a delete: the relation is set null. */
export async function profilePictureUserIds(
  imageIds: number[],
  db: Kysely<DB> = dbWrite
): Promise<number[]> {
  if (!imageIds.length) return [];
  const rows = await db
    .selectFrom('User')
    .select('id')
    .where('profilePictureId', 'in', imageIds)
    .execute();
  return rows.map((x) => x.id);
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
    void logAxiomError(error, { name: 'profile-picture-cache-bust' });
  }
}
