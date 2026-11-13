import { Prisma } from '@prisma/client';
import { childBrowsingTagIds } from '@civitai/shared';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { collectionsSearchIndex } from '~/server/search-index';
import { queueModelsReindex } from '~/server/search-index/queue-models-reindex';

const CHILD_TAG_IDS = [...childBrowsingTagIds];

/** Images with an enabled child browsing tag from Rekognition, above imageId `after`. */
export const childLabelImageIdsSql = (after: number) => Prisma.sql`
  SELECT DISTINCT "imageId"
  FROM "TagsOnImageDetails"
  WHERE "tagId" = ANY(${CHILD_TAG_IDS}::int[])
    AND "source" = 'Rekognition'::"TagSource"
    AND "disabled" = false
    AND "imageId" > ${after}
`;

/** Which of these images WD14 also tagged. */
export const wd14ImageIdsSql = (imageIds: number[]) => Prisma.sql`
  SELECT DISTINCT "imageId"
  FROM "TagsOnImageDetails"
  WHERE "imageId" = ANY(${imageIds}::int[]) AND "source" = 'WD14'::"TagSource"
`;

/** Models with a version whose posts hold these images. */
export const modelIdsForImagesSql = (imageIds: number[]) => Prisma.sql`
  SELECT DISTINCT mv."modelId" AS id
  FROM "Image" i
  JOIN "Post" p ON p.id = i."postId"
  JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
  WHERE i.id = ANY(${imageIds}::int[])
`;

/**
 * Collections whose search document can show one of these images: as its cover, or through an item
 * that is the image, its post, a model in `modelIds`, an article it covers or a 3D model it is the
 * thumbnail of. One pass over CollectionItem.
 */
export const collectionIdsForImagesSql = (imageIds: number[], modelIds: number[]) => Prisma.sql`
  WITH posts AS (
    SELECT DISTINCT "postId" AS id FROM "Image" WHERE id = ANY(${imageIds}::int[]) AND "postId" IS NOT NULL
  ), articles AS (
    SELECT id FROM "Article"
    WHERE "coverId" = ANY(${imageIds}::int[]) OR "bannerId" = ANY(${imageIds}::int[])
  ), models3d AS (
    SELECT id FROM "Model3D" WHERE "thumbnailImageId" = ANY(${imageIds}::int[])
  )
  SELECT c.id FROM "Collection" c WHERE c."imageId" = ANY(${imageIds}::int[])
  UNION
  SELECT ci."collectionId" AS id
  FROM "CollectionItem" ci
  WHERE ci."imageId" = ANY(${imageIds}::int[])
    OR ci."postId" IN (SELECT id FROM posts)
    OR ci."modelId" = ANY(${modelIds}::int[])
    OR ci."articleId" IN (SELECT id FROM articles)
    OR ci."model3dId" IN (SELECT id FROM models3d)
`;

const ids = async (sql: Prisma.Sql) =>
  (await dbRead.$queryRaw<{ id: number }[]>(sql)).map((r) => r.id);

/** The selected images, ascending: child-labelled by Rekognition and also tagged by WD14. */
async function selectImageIds(after: number, chunkSize: number) {
  const candidates = (
    await dbRead.$queryRaw<{ imageId: number }[]>(childLabelImageIdsSql(after))
  ).map((r) => r.imageId);
  const selected: number[] = [];
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const rows = await dbRead.$queryRaw<{ imageId: number }[]>(
      wd14ImageIdsSql(candidates.slice(i, i + chunkSize))
    );
    for (const r of rows) selected.push(r.imageId);
  }
  return selected.sort((a, b) => a - b);
}

const chunked = (list: number[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size)
  );

export type ChildLabelReindexOptions = {
  step: 'bust' | 'reindex';
  dryRun: boolean;
  chunkSize: number;
  /** Start above this imageId (resume). */
  after?: number;
  /** step=bust: stop after this many chunks; `lastImageId` is where to resume. */
  maxChunks?: number;
};

/**
 * step=bust rewrites each selected image's tagIdsForImagesCache entry from the database
 * (`refresh`), then reads it back: `verified` counts entries now holding a child tag id. If none of
 * the first chunk's do, the run stops: the deployed lookup still drops the label.
 * step=reindex queues the models and collections whose search documents can carry those images.
 * dryRun counts and writes nothing.
 */
export async function runChildLabelReindex({
  step,
  dryRun,
  chunkSize,
  after = 0,
  maxChunks,
}: ChildLabelReindexOptions) {
  const imageIds = await selectImageIds(after, chunkSize);

  if (step === 'bust') {
    const all = chunked(imageIds, chunkSize);
    const chunks = maxChunks ? all.slice(0, maxChunks) : all;
    let refreshed = 0;
    let verified = 0;
    let lastImageId: number | undefined;
    if (!dryRun) {
      for (const [index, chunk] of chunks.entries()) {
        await tagIdsForImagesCache.refresh(chunk);
        refreshed += chunk.length;
        const entries = await tagIdsForImagesCache.fetch(chunk, { bypassLocal: true });
        const ok = chunk.filter((id) =>
          entries[id]?.tags.some((tagId) => CHILD_TAG_IDS.includes(tagId))
        ).length;
        verified += ok;
        lastImageId = chunk[chunk.length - 1];
        if (index === 0 && ok === 0)
          return {
            step,
            dryRun,
            images: imageIds.length,
            chunks: chunks.length,
            refreshed,
            verified,
            lastImageId,
            aborted: 'refreshed entries hold no child tag: the deployed lookup still drops it',
          };
      }
    }
    return {
      step,
      dryRun,
      images: imageIds.length,
      chunks: chunks.length,
      refreshed,
      verified,
      lastImageId,
    };
  }

  const modelIds = imageIds.length ? await ids(modelIdsForImagesSql(imageIds)) : [];
  const collectionIds = imageIds.length
    ? await ids(collectionIdsForImagesSql(imageIds, modelIds))
    : [];
  const models = await queueModelsReindex(modelIds, { dryRun, chunkSize });
  let collectionsQueued = 0;
  if (!dryRun) {
    for (const chunk of chunked(collectionIds, chunkSize)) {
      await collectionsSearchIndex.queueUpdate(
        chunk.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
      collectionsQueued += chunk.length;
    }
  }
  return {
    step,
    dryRun,
    images: imageIds.length,
    models,
    collections: collectionIds.length,
    collectionsQueued,
  };
}
