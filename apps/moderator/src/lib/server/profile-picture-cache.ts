import {
  clearHeldUserImages,
  dropStaleHeldImageMarkers,
  pictureUserIds,
  restoreClearedUserImages,
} from '@civitai/db-queries/profile-picture-clear';
import { bustEventEngineProfilePictures, REDIS_KEYS } from '@civitai/redis';
import { logAxiomError } from './axiom';
import { bustCachedObject } from './cache';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbWrite } from './db';
import { getRedis } from './redis';
import { syncSearchIndexBulk } from './search-index';

/**
 * The users whose profile picture is one of `imageIds`, and the owners whose `User.image` names one of
 * them. Read before a delete: the relation is set null.
 */
export async function profilePictureUserIds(
  imageIds: number[],
  db: Kysely<DB> = dbWrite
): Promise<number[]> {
  return pictureUserIds(db, imageIds);
}

// The main app and the event engine each cache a user's profile picture for a day, and avatars are
// shown or hidden on its rating. A held or blocked picture also clears the legacy `User.image` naming
// it, and a picture servable again puts it back, both by the statements the main app runs; the users
// whose `User.image` either touched get their basic-user entry, session and search document refreshed.
// Never throws: it follows a committed moderation write.
export async function bustProfilePictures(
  target: { imageIds: number[] } | { userIds: number[] }
): Promise<void> {
  try {
    const userIds =
      'userIds' in target ? target.userIds : await profilePictureUserIds(target.imageIds);
    const step = (name: string, run: () => Promise<number[]>) =>
      run().catch((error) => {
        void logAxiomError(error, { event: `profile-picture-${name}`, userIds: userIds.join(',') });
        return [] as number[];
      });
    const heldUserIds = await step('clear', () => clearHeldUserImages(dbWrite, userIds));
    const restoredUserIds = await step('restore', () => restoreClearedUserImages(dbWrite, userIds));
    await step('drop-stale-markers', () => dropStaleHeldImageMarkers(dbWrite, userIds));
    const changedUserIds = [...new Set([...heldUserIds, ...restoredUserIds])];
    await Promise.all([
      bustCachedObject(REDIS_KEYS.CACHES.BASIC_USERS, changedUserIds).catch((error) =>
        logAxiomError(error, { event: 'profile-picture-cache-bust', cache: 'basic-users' })
      ),
      // The session shape carries the avatar url; the next session read re-produces it.
      ...changedUserIds.map((id) =>
        getRedis()
          .del(`${REDIS_KEYS.USER.SESSION}:${id}`)
          .catch((error) =>
            logAxiomError(error, { event: 'profile-picture-cache-bust', cache: 'session' })
          )
      ),
      syncSearchIndexBulk({
        entityType: 'user',
        entityIds: changedUserIds,
        action: 'update',
      }).catch((error) =>
        logAxiomError(error, { event: 'profile-picture-cache-bust', cache: 'search' })
      ),
      bustCachedObject(REDIS_KEYS.CACHES.PROFILE_PICTURES, userIds).catch((error) =>
        logAxiomError(error, { event: 'profile-picture-cache-bust' })
      ),
      bustEventEngineProfilePictures(getRedis(), userIds).catch((error) =>
        logAxiomError(error, { event: 'profile-picture-cache-bust', cache: 'event-engine' })
      ),
    ]);
  } catch (error) {
    void logAxiomError(error, { event: 'profile-picture-cache-bust' });
  }
}
