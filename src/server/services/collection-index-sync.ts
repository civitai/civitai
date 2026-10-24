import { dbRead } from '~/server/db/client';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';
import { logToAxiom } from '~/server/logging/client';

// The feed index carries `collectionIds` for ACCEPTED membership of non-private
// collections, and nothing about a CollectionItem write reaches the index on its
// own: the incremental sweep keys off Image.updatedAt, which a membership change
// does not touch. Without an explicit enqueue a change propagates never, not late.
//
// Private collections are not indexed, so a write touching only those is a no-op
// here. That is most of them — private membership is ~88% of all rows — so the
// read-config check is what keeps this cheap on the common path.
export async function queueCollectionMembershipUpdate({
  collectionIds,
  imageIds,
}: {
  collectionIds: number[];
  imageIds: number[];
}) {
  if (!imageIds.length || !collectionIds.length) return;

  try {
    const indexed = await dbRead.collection.findFirst({
      where: { id: { in: collectionIds }, read: { not: CollectionReadConfiguration.Private } },
      select: { id: true },
    });
    if (!indexed) return;

    await queueImageSearchIndexUpdate({
      ids: [...new Set(imageIds)],
      action: SearchIndexUpdateQueueAction.Update,
    });
  } catch (error) {
    // A failed enqueue must not fail the write the user asked for. The cost is a
    // stale hub entry until the next full reindex, so it is logged rather than
    // swallowed — silence here looks identical to "no non-private collection".
    logToAxiom({
      type: 'error',
      name: 'collection-membership-index-enqueue-failed',
      message: error instanceof Error ? error.message : 'unknown',
      collectionIds,
      imageCount: imageIds.length,
    }).catch(() => undefined);
  }
}

// Membership also changes without any CollectionItem write: flipping
// Collection.read between Private and Public changes what a hub may show while
// touching no membership row. Fans out to the whole collection, so it is bounded
// and the caller is told when it was truncated rather than silently partial.
export async function queueCollectionReadConfigChange({
  collectionId,
  limit = 20_000,
}: {
  collectionId: number;
  limit?: number;
}) {
  const items = await dbRead.collectionItem.findMany({
    where: { collectionId, imageId: { not: null } },
    select: { imageId: true },
    take: limit + 1,
  });

  const truncated = items.length > limit;
  const imageIds = items
    .slice(0, limit)
    .map((i) => i.imageId)
    .filter((id): id is number => !!id);

  if (imageIds.length)
    await queueImageSearchIndexUpdate({
      ids: imageIds,
      action: SearchIndexUpdateQueueAction.Update,
    });

  if (truncated)
    logToAxiom({
      type: 'warning',
      name: 'collection-read-change-enqueue-truncated',
      message: `Collection ${collectionId} exceeded ${limit} items; remaining membership is stale until a reindex.`,
      collectionId,
    }).catch(() => undefined);

  return { queued: imageIds.length, truncated };
}
