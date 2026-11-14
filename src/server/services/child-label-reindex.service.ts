import { Prisma } from '@prisma/client';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbRead } from '~/server/db/client';
import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';
import { searchClient } from '~/server/meilisearch/client';
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

// Far above any chunk's candidates, so none is dropped.
const CANDIDATE_CAP = 1_000_000;
const DOCUMENT_READ_BATCH = 1000;

type StoredCollectionDocument = {
  id: number;
  image?: { id: number } | null;
  images?: { id: number }[] | null;
};

/**
 * Of the collections any route reaches these images by, the ones whose stored search document
 * shows one of them. The stored document, not today's rows, decides: a document built when its
 * collection showed one of these images still does, until it is rebuilt. A batch whose documents
 * cannot be read is queued whole, and a candidate with no document is queued too.
 */
async function collectionIdsShowingImages(imageIds: number[]) {
  const wanted = new Set(imageIds);
  const candidates = await getCollectionIdsForImages({
    imageIds,
    source: SOURCE,
    cap: CANDIDATE_CAP,
    db: dbRead,
    throwOnError: true,
  });
  const shown: number[] = [];
  let unread = 0;
  let missing = 0;
  for (const batch of chunkIds(candidates.collectionIds, DOCUMENT_READ_BATCH)) {
    try {
      if (!searchClient) throw new Error('search client not configured');
      const { results } = await searchClient
        .index(COLLECTIONS_SEARCH_INDEX)
        .getDocuments<StoredCollectionDocument>({
          filter: `id IN [${batch.join(',')}]`,
          fields: ['id', 'image', 'images'],
          limit: batch.length,
        });
      const read = new Set<number>();
      for (const doc of results) {
        read.add(doc.id);
        const docImageIds = [doc.image?.id, ...(doc.images ?? []).map((image) => image.id)];
        if (docImageIds.some((id) => id !== undefined && wanted.has(id))) shown.push(doc.id);
      }
      const absent = batch.filter((id) => !read.has(id));
      shown.push(...absent);
      missing += absent.length;
    } catch {
      shown.push(...batch);
      unread += batch.length;
    }
  }
  return { collectionIds: shown, truncated: candidates.truncated, unread, missing };
}

/** The models and collections whose search documents show these images, a chunk at a time. */
async function documentIdsForImages(imageIds: number[], chunkSize: number) {
  const modelIds = new Set<number>();
  const collectionIds = new Set<number>();
  let truncated = false;
  let unread = 0;
  let missing = 0;
  for (const chunk of chunkIds(imageIds, chunkSize)) {
    for (const id of await ids(modelIdsForImagesSql(chunk))) modelIds.add(id);
    const collections = await collectionIdsShowingImages(chunk);
    for (const id of collections.collectionIds) collectionIds.add(id);
    truncated ||= collections.truncated;
    unread += collections.unread;
    missing += collections.missing;
  }
  return { modelIds: [...modelIds], collectionIds: [...collectionIds], truncated, unread, missing };
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

  let documents: Awaited<ReturnType<typeof documentIdsForImages>>;
  try {
    documents = await documentIdsForImages(imageIds, chunkSize);
  } catch {
    return {
      step,
      dryRun,
      images: imageIds.length,
      probe: probe.length,
      probeVerified,
      lastImageId: after,
      done: false,
      aborted: 'the collection lookup failed: retry from the same `after`',
    };
  }
  const { modelIds, collectionIds, truncated, unread, missing } = documents;
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
    collectionsUnread: unread,
    collectionsMissing: missing,
    collectionsQueued,
  };
}
