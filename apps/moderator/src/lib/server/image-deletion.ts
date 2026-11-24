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
import { imageDeleteHeldSqlText, imageDeleteHoldLegs } from './delete-hold-sql';
import type { ImageKeptReason, KeptImage } from '$lib/image-kept-reasons';

type DeletedImage = { id: number; postId: number | null; parentId: number | null };

export type DeletedImageRows = {
  deleted: DeletedImage[];
  notReturned: number[];
  /** Kept for its child-safety case and blocked by the delete, so out of search like a deleted one. */
  hidden: HiddenImage[];
  avatarUserIds: number[];
  /**
   * Not deleted. `evidence`: blocked by the hold marker's delete trigger. `review`: kept for its
   * child-safety case, and also in `hidden` if the delete blocked it. Any other image, a `review` one
   * a hold refused included, is left as it was.
   */
  refused: KeptImage[];
};

const legs = imageDeleteHoldLegs('"Image"');
const imageHeld = sql<boolean>`${sql.raw(imageDeleteHeldSqlText('"Image"'))}`;
const ownerMarked = sql<boolean>`EXISTS (
  SELECT 1 FROM "EvidenceHeldUser" marker WHERE marker."userId" = "Image"."userId"
)`;
const reviewHeld = sql<boolean>`${sql.raw(`(${legs.review} OR ${legs.block} OR ${legs.listed})`)}`;
// A marked owner's image still goes to the DELETE: the marker's trigger keeps the evidence and
// blocks the image, which a refusal alone would leave live.
const deletable = sql<boolean>`(NOT ${imageHeld} OR ${ownerMarked})`;

async function heldImages(trx: Kysely<DB>, ids: number[]): Promise<KeptImage[]> {
  if (!ids.length) return [];
  const rows = await trx
    .selectFrom('Image')
    .select(['id', ownerMarked.as('marked'), reviewHeld.as('reviewHeld')])
    .where('id', 'in', ids)
    .where(imageHeld)
    .execute();
  const reasons = new Map(
    rows.map((row): [number, ImageKeptReason] => [
      row.id,
      row.marked ? 'evidence' : row.reviewHeld ? 'review' : 'account',
    ])
  );
  return ids.flatMap((id) => {
    const reason = reasons.get(id);
    return reason ? [{ id, reason }] : [];
  });
}

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
  // A hold written to one of these rows now waits for this delete rather than landing between its
  // statements; a new report listing one is still caught by the guards below.
  if (ids.length)
    await trx
      .selectFrom('Image')
      .select('id')
      .where('id', 'in', ids)
      .orderBy('id')
      .forUpdate()
      .execute();
  const untouched = (await heldImages(trx, ids)).filter((image) => image.reason !== 'evidence');
  const skip = new Set(untouched.map((image) => image.id));
  const toDelete = ids.filter((id) => !skip.has(id));
  const avatarUserIds = await profilePictureUserIds(toDelete, trx);
  const deleted: DeletedImage[] = [];
  // No row came back: already gone, kept by a hold marker's trigger, or held since the check.
  const notReturned: number[] = [];
  const keptForReview: KeptImage[] = [];
  const hidden: HiddenImage[] = [];
  for (const id of toDelete) {
    // The guard is re-checked here, so a hold placed after the check above still keeps the image.
    // Every delete here is a moderator's, so the file goes with all its versions (see `moderatorPurge`).
    const {
      deleted: [image],
      kept,
      hidden: blocked,
    } = await deleteRows(trx, {
      ids: [id],
      actor,
      where: deletable,
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
  const heldLate = await heldImages(trx, notReturned);
  // An untouched image keeps its search entry; one the trigger blocked leaves search.
  const untouchedLate = new Set(
    heldLate.filter((image) => image.reason !== 'evidence').map((image) => image.id)
  );
  return {
    deleted,
    notReturned: notReturned.filter((id) => !untouchedLate.has(id)),
    hidden,
    avatarUserIds,
    refused: [...untouched, ...heldLate, ...keptForReview],
  };
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
  await bustKeptImages(notReturned, affectedPostIds);
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
      // Kept images' posts are added by bustKeptImages; the DELETE already queued the deleted rows'.
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
 * deleted image is invalidated. Returns the images a hold or a child-safety case kept.
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

// A kept image is now blocked and out of its post (`EvidenceHoldImage` names the post), so its
// caches and that post's are as stale as a deleted image's.
async function bustKeptImages(ids: number[], affectedPostIds: Set<number>): Promise<void> {
  if (!ids.length) return;
  try {
    const kept = await dbWrite
      .selectFrom('EvidenceHoldImage')
      .select(['imageId', 'postId'])
      .where('imageId', 'in', ids)
      .execute();
    for (const { imageId, postId } of kept) {
      if (postId != null) affectedPostIds.add(postId);
      await getSysRedis()
        .packed.set(
          `${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${imageId}` as RedisKeyTemplateSys,
          'false',
          { EX: 60 * 5 }
        )
        .catch(() => undefined);
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_META, imageId);
      await bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, imageId);
    }
  } catch (err) {
    logImageDeletionError(err, 'kept image bust', ids);
  }
}
