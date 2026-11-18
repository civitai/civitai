import { childBrowsingTagIds } from '@civitai/shared';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { sleep } from '~/server/utils/concurrency-helpers';

const CHILD_TAG_IDS = [...childBrowsingTagIds];
const childTagIds = new Set<number>(CHILD_TAG_IDS);

type ImageChildTagChanges = {
  /** Images whose tags were written; those whose written tags include a child tag are queued. */
  tagWrites?: { imageId: number; tagId: number }[];
  /**
   * Images whose nsfwLevel may have changed; queued while they carry a child tag or the minor flag,
   * since either rule reads the level.
   */
  levelImageIds?: number[];
  /** Images whose minor flag was written; always queued, since the minor rule reads no tags. */
  minorImageIds?: number[];
};

/**
 * Queue a search-index rewrite for the models whose posts hold these images (after re-reading their
 * cached tags and showcase images from the primary), for the articles and comics using them as a
 * cover or banner, and for the collections and bounties whose documents show them. The models sync re-picks a model only when `Model.updatedAt` moves, so a change to
 * an image's child browsing tags or nsfwLevel reaches its model documents only through here.
 * Never throws: it runs after the tag, level or minor-flag write has committed. A failed attempt is retried once;
 * a second failure is logged and the requeue is dropped. The queue call does not throw when Redis
 * refuses the ids; past that, ids are lost only if the queue's own fallback also fails.
 */
export async function queueModelsForImageChildTagChanges({
  minorImageIds = [],
  ...changes
}: ImageChildTagChanges) {
  // A model's minor flag rewrites every image of its versions: bounded queries per batch.
  await withRetry(() =>
    queueChanged({ ...changes, minorImageIds: minorImageIds.slice(0, MINOR_BATCH) })
  );
  for (let i = MINOR_BATCH; i < minorImageIds.length; i += MINOR_BATCH) {
    const batch = minorImageIds.slice(i, i + MINOR_BATCH);
    await withRetry(() => queueChanged({ minorImageIds: batch }));
  }
}

const MINOR_BATCH = 1000;

/**
 * Queue an update for the articles using these images as cover or banner and the comics using them
 * as cover, whatever changed about the images. Never throws, with the same retry as above.
 */
export async function queueArticlesAndComicsForImages(imageIds: number[]) {
  if (!imageIds.length) return;
  await withRetry(() => queueArticlesAndComics([...new Set(imageIds)]));
}

async function withRetry(run: () => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      logError(e);
      if (attempt >= ATTEMPTS) return;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

const ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;

function logError(e: unknown) {
  const error = e as Error;
  logToAxiom({
    type: 'error',
    name: 'image-models-reindex',
    message: error.message,
    stack: error.stack,
  });
}

async function queueChanged({
  tagWrites = [],
  levelImageIds = [],
  minorImageIds = [],
}: ImageChildTagChanges) {
  const imageIds = new Set([
    ...tagWrites.filter((x) => childTagIds.has(x.tagId)).map((x) => x.imageId),
    ...minorImageIds,
  ]);

  const levelOnly = [...new Set(levelImageIds)].filter((id) => !imageIds.has(id));
  if (levelOnly.length) {
    // Primary: the tag or flag that makes the image count may have been written moments ago.
    const tagged = await dbWrite.$queryRaw<{ imageId: number }[]>`
      SELECT "imageId"
      FROM "TagsOnImageNew"
      WHERE "imageId" = ANY(${levelOnly}::int[])
        AND "tagId" = ANY(${CHILD_TAG_IDS}::int[])
      UNION
      SELECT id FROM "Image" WHERE id = ANY(${levelOnly}::int[]) AND minor
    `;
    for (const { imageId } of tagged) imageIds.add(imageId);
  }

  if (!imageIds.size) return;
  const ids = [...imageIds];
  await Promise.all([
    queueModels(ids),
    queueArticlesAndComics(ids),
    queueCollectionsAndBounties(ids),
  ]);
}

async function queueModels(imageIds: number[]) {
  // Primary: the image or its post may be moments old.
  const rows = await dbWrite.$queryRaw<{ modelVersionId: number; modelId: number }[]>`
    SELECT DISTINCT p."modelVersionId", mv."modelId"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    WHERE i.id = ANY(${imageIds}::int[])
  `;
  if (!rows.length) return;

  // Call-site imports: both modules import image.service, which calls this.
  const [{ imagesForModelVersionsCache }, { modelsSearchIndex }] = await Promise.all([
    import('~/server/services/image.service'),
    import('~/server/search-index/models.search-index'),
  ]);
  // The index reads both caches. Refresh reads the primary; after a bust the next reader could
  // refill them from a lagging replica. A failure here must not cost the other refresh or the queue.
  await Promise.all([
    tagIdsForImagesCache.refresh(imageIds).catch(logError),
    imagesForModelVersionsCache
      .refresh([...new Set(rows.map((r) => r.modelVersionId))])
      .catch(logError),
  ]);
  // Doesn't throw when Redis refuses.
  await modelsSearchIndex.queueUpdate(toUpdates(rows.map((r) => r.modelId)));
}

async function queueArticlesAndComics(imageIds: number[]) {
  const rows = await dbWrite.$queryRaw<{ kind: 'article' | 'comic'; id: number }[]>`
    SELECT 'article' AS kind, id FROM "Article"
    WHERE "coverId" = ANY(${imageIds}::int[]) OR "bannerId" = ANY(${imageIds}::int[])
    UNION
    SELECT 'comic' AS kind, id FROM "ComicProject"
    WHERE "coverImageId" = ANY(${imageIds}::int[])
  `;
  const articleIds = rows.filter((r) => r.kind === 'article').map((r) => r.id);
  const comicIds = rows.filter((r) => r.kind === 'comic').map((r) => r.id);
  if (!articleIds.length && !comicIds.length) return;

  const [{ articlesSearchIndex }, { comicsSearchIndex }] = await Promise.all([
    import('~/server/search-index/articles.search-index'),
    import('~/server/search-index/comics.search-index'),
  ]);
  await Promise.all([
    articleIds.length && articlesSearchIndex.queueUpdate(toUpdates(articleIds), { reason: REASON }),
    comicIds.length && comicsSearchIndex.queueUpdate(toUpdates(comicIds), { reason: REASON }),
  ]);
}

async function queueCollectionsAndBounties(imageIds: number[]) {
  // Call-site imports, as above: both modules reach image.service.
  const [{ getCollectionIdsForImages, enqueueCollectionRebuild }, { bountiesSearchIndex }] =
    await Promise.all([
      import('~/server/services/collection-media-index'),
      import('~/server/search-index/bounties.search-index'),
    ]);
  const [collections, bountyRows] = await Promise.all([
    getCollectionIdsForImages({ imageIds, source: REASON, throwOnError: true }),
    dbWrite.$queryRaw<{ id: number }[]>`
      SELECT DISTINCT "entityId" AS id FROM "ImageConnection"
      WHERE "entityType" = 'Bounty' AND "imageId" = ANY(${imageIds}::int[])
    `,
    // The collections index reads these tags from the cache: refill it from the primary first.
    tagIdsForImagesCache.refresh(imageIds).catch(logError),
  ]);
  await Promise.all([
    enqueueCollectionRebuild({ ...collections, source: REASON }),
    bountyRows.length &&
      bountiesSearchIndex.queueUpdate(toUpdates(bountyRows.map((r) => r.id)), { reason: REASON }),
  ]);
}

const REASON = 'image-child-tag-change';

const toUpdates = (ids: number[]) =>
  [...new Set(ids)].map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }));
