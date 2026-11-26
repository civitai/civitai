import { clearHeldUserImages, pictureUserIds } from '@civitai/db-queries/profile-picture-clear';
import { REDIS_KEYS } from '@civitai/redis';
import { logAxiomError } from './axiom';
import { bustCachedObject } from './cache';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbWrite } from './db';
import { getRedis } from './redis';
import { syncSearchIndexBulk } from './search-index';

/** `pictureUserIds` on `db`. Read before a delete: the relation is set null. */
export async function profilePictureUserIds(
  imageIds: number[],
  db: Kysely<DB> = dbWrite
): Promise<number[]> {
  return pictureUserIds(db, imageIds);
}

/** The main app's `PROFILE_PICTURE_SESSION_REFRESH_CONCURRENCY`: a bulk moderation can reach many users. */
const SESSION_EVICT_CONCURRENCY = 10;

/** Deletes these users' sessions, a few at a time; the next session read re-produces each. */
async function evictSessions(userIds: number[]) {
  const ids = [...new Set(userIds)];
  for (let at = 0; at < ids.length; at += SESSION_EVICT_CONCURRENCY)
    await Promise.all(
      ids.slice(at, at + SESSION_EVICT_CONCURRENCY).map((id) =>
        getRedis()
          .del(`${REDIS_KEYS.USER.SESSION}:${id}`)
          .catch((error) =>
            logAxiomError(error, { event: 'profile-picture-cache-bust', cache: 'session' })
          )
      )
    );
}

// The main app caches a user's profile picture for a day, and avatars are shown or hidden on its
// rating. A held or blocked picture also clears the legacy `User.image` naming
// it, by the statement the main app runs; the users whose picture is held or blocked get their
// basic-user entry and search document refreshed. Every user the pictures reach loses their
// session, whose shape carries the avatar url, as in the main app's `refreshProfilePicturesForUsers`:
// a re-rate can hide a picture without clearing `User.image`.
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
    const changedUserIds = await step('clear', () => clearHeldUserImages(dbWrite, userIds));
    await Promise.all([
      bustCachedObject(REDIS_KEYS.CACHES.BASIC_USERS, changedUserIds).catch((error) =>
        logAxiomError(error, { event: 'profile-picture-cache-bust', cache: 'basic-users' })
      ),
      evictSessions(userIds),
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
    ]);
  } catch (error) {
    void logAxiomError(error, { event: 'profile-picture-cache-bust' });
  }
}
