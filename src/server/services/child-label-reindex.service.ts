import { Prisma } from '@prisma/client';
import { childBrowsingTagIds } from '@civitai/shared';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { collectionsSearchIndex } from '~/server/search-index';
import { queueModelsReindex } from '~/server/search-index/queue-models-reindex';

/**
 * Images carrying a child browsing tag from Rekognition that WD14 also tagged, after imageId
 * `after`, ascending, `limit` of them.
 */
export const childLabelImageIdsSql = (after: number, limit: number) => Prisma.sql`
  SELECT DISTINCT r."imageId"
  FROM "TagsOnImageDetails" r
  WHERE r."tagId" = ANY(${[...childBrowsingTagIds]}::int[])
    AND r."source" = 'Rekognition'::"TagSource"
    AND r."disabled" = false
    AND r."imageId" > ${after}
    AND EXISTS (
      SELECT 1 FROM "TagsOnImageDetails" w
      WHERE w."imageId" = r."imageId" AND w."source" = 'WD14'::"TagSource"
    )
  ORDER BY r."imageId"
  LIMIT ${limit}
`;

/** Models with a version whose posts hold these images. */
export const modelIdsForImagesSql = (imageIds: number[]) => Prisma.sql`
  SELECT DISTINCT mv."modelId" AS id
  FROM "Image" i
  JOIN "Post" p ON p.id = i."postId"
  JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
  WHERE i.id = ANY(${imageIds}::int[])
`;

/** Collections with one of these images as cover or item, directly or through the item's post. */
export const collectionIdsForImagesSql = (imageIds: number[]) => Prisma.sql`
  SELECT c.id FROM "Collection" c WHERE c."imageId" = ANY(${imageIds}::int[])
  UNION
  SELECT ci."collectionId" AS id FROM "CollectionItem" ci WHERE ci."imageId" = ANY(${imageIds}::int[])
  UNION
  SELECT ci."collectionId" AS id
  FROM "CollectionItem" ci
  JOIN "Image" i ON i."postId" = ci."postId"
  WHERE i.id = ANY(${imageIds}::int[])
`;

async function* childLabelImageIdChunks(chunkSize: number) {
  let after = 0;
  while (true) {
    const rows = await dbRead.$queryRaw<{ imageId: number }[]>(
      childLabelImageIdsSql(after, chunkSize)
    );
    if (!rows.length) return;
    const ids = rows.map((r) => r.imageId);
    yield ids;
    if (ids.length < chunkSize) return;
    after = ids[ids.length - 1];
  }
}

const idsOf = async (sql: Prisma.Sql) =>
  (await dbRead.$queryRaw<{ id: number }[]>(sql)).map((r) => r.id);

export type ChildLabelReindexOptions = {
  step: 'bust' | 'reindex';
  dryRun: boolean;
  chunkSize: number;
};

/**
 * step=bust rewrites each selected image's tagIdsForImagesCache entry from the database
 * (`refresh`); step=reindex queues the models and collections whose search documents carry those
 * images. dryRun counts and writes nothing.
 */
export async function runChildLabelReindex({ step, dryRun, chunkSize }: ChildLabelReindexOptions) {
  let images = 0;
  let chunks = 0;
  let refreshed = 0;
  const modelIds = new Set<number>();
  const collectionIds = new Set<number>();

  for await (const ids of childLabelImageIdChunks(chunkSize)) {
    images += ids.length;
    chunks++;
    if (step === 'bust') {
      if (!dryRun) {
        await tagIdsForImagesCache.refresh(ids);
        refreshed += ids.length;
      }
      continue;
    }
    for (const id of await idsOf(modelIdsForImagesSql(ids))) modelIds.add(id);
    for (const id of await idsOf(collectionIdsForImagesSql(ids))) collectionIds.add(id);
  }

  if (step === 'bust') return { step, dryRun, images, chunks, refreshed };

  const models = await queueModelsReindex([...modelIds], { dryRun, chunkSize });
  let collectionsQueued = 0;
  if (!dryRun) {
    const ids = [...collectionIds];
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      await collectionsSearchIndex.queueUpdate(
        chunk.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
      collectionsQueued += chunk.length;
    }
  }
  return {
    step,
    dryRun,
    images,
    chunks,
    models,
    collections: collectionIds.size,
    collectionsQueued,
  };
}
