import { Prisma } from '@prisma/client';
import { childBrowsingTagIds } from '@civitai/shared';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { sleep } from '~/server/utils/concurrency-helpers';

const CHILD_TAG_IDS = [...childBrowsingTagIds];
const childTagIds = new Set<number>(CHILD_TAG_IDS);

type ImageChildTagChanges = {
  /** Images whose tags were written; those that gained or lost a child tag are queued. */
  tagWrites?: { imageId: number; tagId: number }[];
  /** Images whose nsfwLevel may have changed; queued while they carry a child tag. */
  levelImageIds?: number[];
};

/**
 * Queue a models-index rewrite for the models whose posts hold these images, after re-reading their
 * cached tags and showcase images from the primary. The models sync re-picks a model only when
 * `Model.updatedAt` moves, so a change to an image's child browsing tags or nsfwLevel reaches its
 * document only through here.
 * Never throws: it runs after the tag or level write has committed. A failed attempt is retried once.
 */
export async function queueModelsForImageChildTagChanges(changes: ImageChildTagChanges) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await queueModels(changes);
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

async function queueModels({ tagWrites = [], levelImageIds = [] }: ImageChildTagChanges) {
  const imageIds = new Set(tagWrites.filter((x) => childTagIds.has(x.tagId)).map((x) => x.imageId));

  const levelOnly = [...new Set(levelImageIds)].filter((id) => !imageIds.has(id));
  if (levelOnly.length) {
    // Primary: the tag that makes the image count may have been written moments ago.
    const tagged = await dbWrite.$queryRaw<{ imageId: number }[]>(Prisma.sql`
      SELECT DISTINCT "imageId"
      FROM "TagsOnImageNew"
      WHERE "imageId" = ANY(${levelOnly}::int[])
        AND "tagId" = ANY(${CHILD_TAG_IDS}::int[])
    `);
    for (const { imageId } of tagged) imageIds.add(imageId);
  }

  if (!imageIds.size) return;
  // Primary: the image or its post may be moments old.
  const rows = await dbWrite.$queryRaw<{ modelVersionId: number; modelId: number }[]>(Prisma.sql`
    SELECT DISTINCT p."modelVersionId", mv."modelId"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    WHERE i.id = ANY(${[...imageIds]}::int[])
  `);
  if (!rows.length) return;

  // Call-site imports: both modules import image.service, which calls this.
  const [{ imagesForModelVersionsCache }, { modelsSearchIndex }] = await Promise.all([
    import('~/server/services/image.service'),
    import('~/server/search-index/models.search-index'),
  ]);
  // The index reads both caches. Refresh reads the primary; after a bust the next reader could
  // refill them from a lagging replica. A failure here must not cost the other refresh or the queue.
  await Promise.all([
    tagIdsForImagesCache.refresh([...imageIds]).catch(logError),
    imagesForModelVersionsCache
      .refresh([...new Set(rows.map((r) => r.modelVersionId))])
      .catch(logError),
  ]);
  // Doesn't throw when Redis refuses.
  await modelsSearchIndex.queueUpdate(
    [...new Set(rows.map((r) => r.modelId))].map((id) => ({
      id,
      action: SearchIndexUpdateQueueAction.Update,
    }))
  );
}
