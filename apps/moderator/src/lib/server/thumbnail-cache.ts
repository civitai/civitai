import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { bustCachedObject } from './cache';
import { dbWrite } from './db';
import { syncSearchIndexBulk } from './search-index';

/** A custom video thumbnail's video id. Guarded so a malformed value can't fail the caller's read. */
export const thumbnailParentId = sql<
  number | null
>`CASE WHEN "metadata"->>'parentId' ~ '^[0-9]{1,9}$' THEN ("metadata"->>'parentId')::int END`;

/**
 * Call after any write that changes an image's rating, blocked state or existence. The main app keys
 * its thumbnailCache by the VIDEO's id, and the video's search document copies the thumbnail's level
 * and url out of that cache — so both are refreshed through the parent, the cache first.
 *
 * Pass `parentIds` when the caller already has them; a deleted row can no longer be asked. Never
 * throws: the moderation write it follows has already committed.
 */
export async function invalidateThumbnails(
  imageIds: number | number[],
  parentIds?: (number | null)[]
): Promise<void> {
  const ids = Array.isArray(imageIds) ? imageIds : [imageIds];
  if (!ids.length) return;
  try {
    const parents =
      parentIds ??
      // Primary, not replica: this runs right after the caller's own write.
      (
        await dbWrite
          .selectFrom('Image')
          .select(thumbnailParentId.as('parentId'))
          .where('id', 'in', ids)
          .execute()
      ).map((row) => row.parentId);
    const parentsToReindex = [
      ...new Set(parents.filter((id): id is number => id != null && !ids.includes(id))),
    ];
    await bustCachedObject(REDIS_KEYS.CACHES.THUMBNAILS, [...ids, ...parentsToReindex]);
    await syncSearchIndexBulk({
      entityType: 'image',
      entityIds: parentsToReindex,
      action: 'update',
    });
  } catch (err) {
    console.error('[thumbnail-cache] invalidation failed', { count: ids.length }, err);
  }
}
