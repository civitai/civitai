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

/** Whether the post is on a minor or SFW-only model, whose gallery level holds its images. */
const postOnHeldModelSql = (postId: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "Post" hp
  JOIN "ModelVersion" hmv ON hmv.id = hp."modelVersionId"
  JOIN "Model" hm ON hm.id = hmv."modelId"
  WHERE hp.id = ${postId} AND (hm.minor OR hm."sfwOnly")
)`;

/**
 * One page, by collection id after `cursor`, of the collections whose cover may come from a minor
 * or SFW-only model: by a model item, a post or image item on one of its posts, an article item
 * whose cover or banner is on one, or a stored cover image on one. The page is `limit` collections
 * scanned, not matched, so its cost does not grow with how many collections one model reaches.
 * `lastScannedId` is the cursor for the next page; it is null when the page scanned nothing.
 */
export async function getCollectionPageCoveredByHeldModels({
  cursor,
  limit,
}: {
  cursor: number;
  limit: number;
}) {
  const rows = await dbRead.$queryRaw<{ id: number; held: boolean }[]>`
    WITH page AS MATERIALIZED (
      SELECT c.id, c."imageId" FROM "Collection" c
      WHERE c.id > ${cursor}
      ORDER BY c.id
      LIMIT ${limit}
    )
    SELECT p.id, (
      EXISTS (
        SELECT 1 FROM "CollectionItem" ci JOIN "Model" m ON m.id = ci."modelId"
        WHERE ci."collectionId" = p.id AND (m.minor OR m."sfwOnly")
      )
      OR EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        WHERE ci."collectionId" = p.id AND ci."postId" IS NOT NULL
          AND ${postOnHeldModelSql(Prisma.sql`ci."postId"`)}
      )
      OR EXISTS (
        SELECT 1 FROM "CollectionItem" ci JOIN "Image" i ON i.id = ci."imageId"
        WHERE ci."collectionId" = p.id AND ${postOnHeldModelSql(Prisma.sql`i."postId"`)}
      )
      OR EXISTS (
        SELECT 1 FROM "Image" i
        WHERE i.id = p."imageId" AND ${postOnHeldModelSql(Prisma.sql`i."postId"`)}
      )
      OR EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        JOIN "Article" a ON a.id = ci."articleId"
        JOIN "Image" i ON i.id IN (a."coverId", a."bannerId")
        WHERE ci."collectionId" = p.id AND ${postOnHeldModelSql(Prisma.sql`i."postId"`)}
      )
    ) held
    FROM page p
    ORDER BY p.id
  `;
  return {
    collectionIds: rows.filter((row) => row.held).map((row) => Number(row.id)),
    scanned: rows.length,
    lastScannedId: rows.length ? Number(rows[rows.length - 1].id) : null,
  };
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
