import { sql } from '@civitai/db/kysely';
import {
  coversOfDeletedSongs,
  deleteImageRows as deleteRows,
  moderatorPurge,
  readSongCovers,
  queuePostNsfwLevelUpdates,
  type DeleteActor,
  type HiddenImage,
} from '@civitai/db-queries/content-deletion';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REDIS_KEYS, REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { dbWrite } from './db';
import { getSysRedis } from './redis';
import { bustCachedObject } from './cache';
import { bustProfilePictures, profilePictureUserIds } from './profile-picture-cache';
import { invalidateThumbnails } from './thumbnail-cache';
import { bustPostGalleryCaches, queueComicsForImages } from './image-moderation-effects';
import { evictHomeBlocks } from './home-blocks';
import { syncSearchIndexBulk } from './search-index';
import { logAxiomError } from './axiom';
import type { KeptImage } from '$lib/image-kept-reasons';

type DeletedImage = { id: number; postId: number | null; parentId: number | null };

export type DeletedImageRows = {
  deleted: DeletedImage[];
  notReturned: number[];
  /** Kept for its child-safety case and blocked by the delete, so out of search like a deleted one. */
  hidden: HiddenImage[];
  avatarUserIds: number[];
  /** Kept for its child-safety case, and also in `hidden` if the delete blocked it. */
  refused: KeptImage[];
};

/**
 * The database half of a delete. The DELETE itself queues each stored file, CDN takedown and post
 * recount for the main app's jobs; one that cannot be queued throws, so the transaction rolls back
 * and the image stays.
 */
async function deleteImageRows(
  trx: Kysely<DB>,
  ids: number[],
  actor: DeleteActor
): Promise<DeletedImageRows> {
  const avatarUserIds = await profilePictureUserIds(ids, trx);
  const deleted: DeletedImage[] = [];
  // No row came back: already gone.
  const notReturned: number[] = [];
  const keptForReview: KeptImage[] = [];
  const hidden: HiddenImage[] = [];
  for (const id of ids) {
    // Every delete here is a moderator's, so the file goes with all its versions (see `moderatorPurge`).
    const {
      deleted: [image],
      kept,
      hidden: blocked,
    } = await deleteRows(trx, {
      ids: [id],
      actor,
      files: { allVersions: moderatorPurge },
      recountPosts: true,
      cdnTakedown: true,
      replay: { moderatorDelete: true },
    });
    // Only once the row is gone (no foreign key cascades these), so a kept image keeps its collections.
    await trx
      .deleteFrom('CollectionItem')
      .where('imageId', '=', id)
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM "Image" WHERE "Image".id = ${id})`)
      .execute();
    if (kept.length) {
      // Kept for its child-safety case; blocked (`hidden`) unless it is the moderator's own.
      keptForReview.push({ id, reason: 'review' });
      hidden.push(...blocked);
      continue;
    }
    if (!image) {
      notReturned.push(id);
      continue;
    }
    deleted.push({ id, postId: image.postId, parentId: image.parentId });
  }
  return { deleted, notReturned, hidden, avatarUserIds, refused: keptForReview };
}

/**
 * Once the transaction commits: everything that could still hand a client a deleted image. Best-effort.
 */
async function finishImageDeletes({
  deleted,
  notReturned,
  hidden,
  avatarUserIds,
}: Omit<DeletedImageRows, 'refused'>): Promise<void> {
  const affectedPostIds = new Set<number>();
  for (const image of [...deleted, ...hidden]) {
    if (image.postId != null) affectedPostIds.add(image.postId);
    try {
      await getSysRedis()
        .packed.set(
          `${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${image.id}` as RedisKeyTemplateSys,
          'false',
          { EX: 60 * 5 }
        )
        .catch(() => undefined);

      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_META, image.id);
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, image.id);
    } catch (err) {
      logImageDeletionError(err, 'cleanup', [image.id]);
    }
  }

  const deletedIds = deleted.map((image) => image.id);
  void syncSearchIndexBulk({
    entityType: 'image',
    entityIds: [...deletedIds, ...notReturned, ...hidden.map((image) => image.id)],
    action: 'delete',
  });
  if (hidden.length) {
    const hiddenIds = hidden.map((image) => image.id);
    await Promise.all([queueComicsForImages(hiddenIds), evictHomeBlocks(hiddenIds)]).catch((err) =>
      logImageDeletionError(err, 'hidden image effects', hiddenIds)
    );
  }
  await invalidateThumbnails(
    deletedIds,
    deleted.map((image) => image.parentId)
  );
  await bustProfilePictures({ userIds: avatarUserIds });
  if (affectedPostIds.size) {
    const postIds = [...affectedPostIds];
    try {
      // The DELETE already queued these posts' recounts.
      await queuePostNsfwLevelUpdates(dbWrite, postIds);
      await bustPostGalleryCaches(postIds);
      // Don't reimplement the main app's postMetrics bucket queue here — a partial write can orphan
      // buckets; the post imageCount self-heals on the next metrics delta-scan.
    } catch (err) {
      logImageDeletionError(err, 'post recompute', postIds);
    }
  }
}

/**
 * The rows of `ids`, then the covers of the songs among them that went: the song's delete cascades
 * its `Track` row, the only link to its cover, so the covers are read first. A cover goes through
 * the same delete, so a hold on it keeps it as it would any image.
 */
async function deleteImagesAndSongCovers(
  trx: Kysely<DB>,
  ids: number[],
  actor: DeleteActor
): Promise<DeletedImageRows> {
  const covers = await readSongCovers(trx, ids);
  const removal = await deleteImageRows(trx, ids, actor);
  const coverIds = coversOfDeletedSongs(covers, removal.deleted, ids);
  if (!coverIds.length) return removal;
  const coverRemoval = await deleteImageRows(trx, coverIds, actor);
  return {
    deleted: [...removal.deleted, ...coverRemoval.deleted],
    notReturned: [...removal.notReturned, ...coverRemoval.notReturned],
    hidden: [...removal.hidden, ...coverRemoval.hidden],
    avatarUserIds: [...removal.avatarUserIds, ...coverRemoval.avatarUserIds],
    refused: [...removal.refused, ...coverRemoval.refused],
  };
}

/**
 * The only image delete in this app: the rows go, then everything that could still hand a client a
 * deleted image is invalidated. Returns the images a child-safety case kept.
 */
export async function deleteImages(ids: number[], actor: DeleteActor): Promise<KeptImage[]> {
  if (!ids.length) return [];
  const removal = await dbWrite
    .transaction()
    .execute((trx) => deleteImagesAndSongCovers(trx, ids, actor));
  await finishImageDeletes(removal);
  return removal.refused;
}

function logImageDeletionError(error: unknown, step: string, imageIds: number[]) {
  void logAxiomError(error, { event: 'image-deletion', step, imageIds });
}
