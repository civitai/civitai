import { dbRead } from '~/server/db/client';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';
import { logToAxiom } from '~/server/logging/client';
import { Prisma } from '@prisma/client';
import {
  enqueueCollectionRebuild,
  getCollectionIdsForModelImages,
} from '~/server/services/collection-media-index';
import { legacyCoverStringAllowedSql } from '~/server/services/collection-cover-visibility';

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
    });
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
    });

  return { queued: imageIds.length, truncated };
}

/**
 * The collections whose cover may come from these models' posts: by a model item, a post or image
 * item on one of their posts, an article item whose cover or banner is on one, or a stored cover
 * image on one.
 */
export async function getCollectionIdsCoveredByModels(modelIds: number[]) {
  if (!modelIds.length) return [];
  const models = Prisma.join(modelIds);
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    WITH posts AS MATERIALIZED (
      SELECT p.id FROM "Post" p
      JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
      WHERE mv."modelId" IN (${models})
    )
    SELECT ci."collectionId" id FROM "CollectionItem" ci WHERE ci."modelId" IN (${models})
    UNION
    SELECT ci."collectionId" FROM "CollectionItem" ci WHERE ci."postId" IN (SELECT id FROM posts)
    UNION
    SELECT ci."collectionId" FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE i."postId" IN (SELECT id FROM posts)
    UNION
    SELECT c.id FROM "Collection" c
    JOIN "Image" i ON i.id = c."imageId"
    WHERE i."postId" IN (SELECT id FROM posts)
    UNION
    SELECT ci."collectionId" FROM "CollectionItem" ci
    JOIN "Article" a ON a.id = ci."articleId"
    JOIN "Image" i ON i.id = a."coverId"
    WHERE i."postId" IN (SELECT id FROM posts)
    UNION
    SELECT ci."collectionId" FROM "CollectionItem" ci
    JOIN "Article" a ON a.id = ci."articleId"
    JOIN "Image" i ON i.id = a."bannerId"
    WHERE i."postId" IN (SELECT id FROM posts)
  `;
  return rows.map((row) => Number(row.id));
}

/**
 * Rebuild the search documents of the collections whose cover may come from these models, after a
 * change to what a minor or SFW-only model may show: the documents carry covers judged at its
 * gallery level. Never throws; a failure is logged and the documents catch up on their next update.
 */
export async function queueModelCollectionsReindex(modelIds: number[]) {
  const source = 'held-gallery-level';
  for (const modelId of modelIds) {
    const { collectionIds, truncated } = await getCollectionIdsForModelImages({ modelId, source });
    await enqueueCollectionRebuild({ collectionIds, truncated, source });
  }
}

/**
 * One page, by collection id after `cursor`, of the collections with an article item whose legacy
 * cover string the search index may no longer carry: the backfill for that rule.
 */
export async function getCollectionIdsWithWithheldLegacyCover({
  cursor,
  limit,
}: {
  cursor: number;
  limit: number;
}) {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT DISTINCT ci."collectionId" id
    FROM "CollectionItem" ci
    JOIN "Article" a ON a.id = ci."articleId"
    WHERE ci."collectionId" > ${cursor}
      AND a.cover IS NOT NULL
      AND NOT ${legacyCoverStringAllowedSql()}
    ORDER BY ci."collectionId"
    LIMIT ${limit}
  `;
  return rows.map((row) => Number(row.id));
}
