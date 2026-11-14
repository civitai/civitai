import { Prisma } from '@prisma/client';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbRead } from '~/server/db/client';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import {
  enqueueCollectionRebuild,
  getCollectionIdsForImages,
} from '~/server/services/collection-media-index';
import { queueModelsReindex } from '~/server/search-index/queue-models-reindex';
import { chunkIds } from '~/utils/array-helpers';

const CHILD_TAG_IDS = [...childBrowsingTagIds];
const SOURCE = 'child-label-reindex';

/** The next `limit` images above `after` with an enabled child browsing tag from Rekognition. */
export const childLabelImageIdsSql = (after: number, limit: number) => Prisma.sql`
  SELECT DISTINCT "imageId"
  FROM "TagsOnImageDetails"
  WHERE "tagId" = ANY(${CHILD_TAG_IDS}::int[])
    AND "source" = 'Rekognition'::"TagSource"
    AND "disabled" = false
    AND "imageId" > ${after}
  ORDER BY "imageId"
  LIMIT ${limit}
`;

/** Which of these images WD14 also tagged (enabled tags, as the cache lookup reads them). */
export const wd14ImageIdsSql = (imageIds: number[]) => Prisma.sql`
  SELECT DISTINCT "imageId"
  FROM "TagsOnImageDetails"
  WHERE "imageId" = ANY(${imageIds}::int[])
    AND "source" = 'WD14'::"TagSource"
    AND "disabled" = false
`;

/** Models with a version whose posts hold these images. */
export const modelIdsForImagesSql = (imageIds: number[]) => Prisma.sql`
  SELECT DISTINCT mv."modelId" AS id
  FROM "Image" i
  JOIN "Post" p ON p.id = i."postId"
  JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
  WHERE i.id = ANY(${imageIds}::int[])
`;

const ids = async (sql: Prisma.Sql) =>
  (await dbRead.$queryRaw<{ id: number }[]>(sql)).map((r) => r.id);

/**
 * The selected images, ascending: child-labelled by Rekognition and also tagged by WD14. Read in
 * pages of `chunkSize` from a cursor that advances, stopping once `limit` are selected.
 */
async function selectImageIds(after: number, chunkSize: number, limit?: number) {
  const selected: number[] = [];
  let cursor = after;
  while (limit === undefined || selected.length < limit) {
    const page = (
      await dbRead.$queryRaw<{ imageId: number }[]>(childLabelImageIdsSql(cursor, chunkSize))
    ).map((r) => r.imageId);
    if (!page.length) break;
    const rows = await dbRead.$queryRaw<{ imageId: number }[]>(wd14ImageIdsSql(page));
    selected.push(...rows.map((r) => r.imageId).sort((a, b) => a - b));
    cursor = page[page.length - 1];
    if (page.length < chunkSize) break;
  }
  return limit === undefined ? selected : selected.slice(0, limit);
}

/** The models and collections whose search documents can show these images, a chunk at a time. */
async function documentIdsForImages(imageIds: number[], chunkSize: number) {
  const modelIds = new Set<number>();
  const collectionIds = new Set<number>();
  let truncated = false;
  for (const chunk of chunkIds(imageIds, chunkSize)) {
    for (const id of await ids(modelIdsForImagesSql(chunk))) modelIds.add(id);
    const collections = await getCollectionIdsForImages({
      imageIds: chunk,
      source: SOURCE,
      db: dbRead,
    });
    for (const id of collections.collectionIds) collectionIds.add(id);
    truncated ||= collections.truncated;
  }
  return { modelIds: [...modelIds], collectionIds: [...collectionIds], truncated };
}

const holdsChildTag = (entry?: { tags: number[] }) =>
  !!entry?.tags.some((tagId) => CHILD_TAG_IDS.includes(tagId));

export type ChildLabelReindexOptions = {
  step: 'bust' | 'reindex';
  dryRun: boolean;
  chunkSize: number;
  /** Start above this imageId (resume). */
  after?: number;
  /** Stop after this many chunks; `lastImageId` is where to resume. */
  maxChunks?: number;
};

// `refreshed` counts ids sent: refresh swallows its own errors, so only `verified` proves a write.
export async function runChildLabelReindex({
  step,
  dryRun,
  chunkSize,
  after = 0,
  maxChunks,
}: ChildLabelReindexOptions) {
  const limit = maxChunks ? maxChunks * chunkSize : undefined;
  const imageIds = await selectImageIds(after, chunkSize, limit);
  const lastImageId = imageIds[imageIds.length - 1];
  // A selection that filled the limit may have more past it; the next run finds out.
  const done = limit === undefined || imageIds.length < limit;
  if (step === 'bust') {
    const chunks = chunkIds(imageIds, chunkSize);
    let refreshed = 0;
    let verified = 0;
    if (!dryRun) {
      for (const [index, chunk] of chunks.entries()) {
        await tagIdsForImagesCache.refresh(chunk);
        refreshed += chunk.length;
        const entries = await tagIdsForImagesCache.fetch(chunk, {
          bypassLocal: true,
          writeBack: false,
        });
        const ok = chunk.filter((id) => holdsChildTag(entries[id])).length;
        verified += ok;
        if (index === 0 && ok < chunk.length)
          return {
            step,
            dryRun,
            images: imageIds.length,
            chunks: chunks.length,
            refreshed,
            verified,
            // Resume where this run started, so the next run retries the failed chunk.
            lastImageId: after,
            done: false,
            aborted: 'a refreshed entry lacks the child tag: the deployed lookup still drops it',
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
      done,
    };
  }

  // Documents are rebuilt from the cache, so a reindex waits until the first and last image of
  // every bust chunk read back fixed: a bust that stopped early fails it.
  const probe = [
    ...new Set(
      chunkIds(imageIds, chunkSize).flatMap((chunk) => [chunk[0], chunk[chunk.length - 1]])
    ),
  ];
  const probeEntries = probe.length
    ? await tagIdsForImagesCache.fetch(probe, { bypassLocal: true, writeBack: false })
    : {};
  const probeVerified = probe.filter((id) => holdsChildTag(probeEntries[id])).length;
  if (!dryRun && probeVerified < probe.length)
    return {
      step,
      dryRun,
      images: imageIds.length,
      probe: probe.length,
      probeVerified,
      lastImageId: after,
      done: false,
      aborted: 'cached entries lack the child tag: run step=bust on a pod with the fix first',
    };

  const { modelIds, collectionIds, truncated } = await documentIdsForImages(imageIds, chunkSize);
  const models = await queueModelsReindex(modelIds, { dryRun, chunkSize });
  const collectionsQueued = dryRun
    ? 0
    : (await enqueueCollectionRebuild({ collectionIds, truncated, source: SOURCE })).queued;
  return {
    step,
    dryRun,
    images: imageIds.length,
    probe: probe.length,
    probeVerified,
    lastImageId,
    done,
    models,
    collections: collectionIds.length,
    collectionsTruncated: truncated,
    collectionsQueued,
  };
}
