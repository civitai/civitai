import { REDIS_KEYS } from '@civitai/redis';
import { childBrowsingTagIds } from '@civitai/shared';
import { logAxiomError } from './axiom';
import { bustCachedObject } from './cache';
import { dbWrite } from './db';
import { syncSearchIndexBulk } from './search-index';

const CHILD_TAG_IDS = [...childBrowsingTagIds];
const childTagIds = new Set<number>(CHILD_TAG_IDS);

type ImageChildTagChanges = {
  /** Images whose tags were written; those that gained or lost a child tag are queued. */
  tagWrites?: { imageId: number; tagId: number }[];
  /** Images whose nsfwLevel may have changed; queued while they carry a child tag. */
  levelImageIds?: number[];
};

/**
 * For this app's tag and level writes: drops the cached tags and showcase images of the models whose
 * posts hold these images, then queues those models for a models-index rewrite. The queue call itself
 * is fire-and-forget (`syncSearchIndexBulk` logs and does not throw), so the retry covers the reads and
 * the busts. Never throws: it runs after the tag or level write has committed. A failed
 * attempt is retried once.
 */
export async function queueModelsForImageChildTagChanges(
  changes: ImageChildTagChanges
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await queueModels(changes);
    } catch (error) {
      logError(error);
      if (attempt >= ATTEMPTS) return;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

const ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
const logError = (error: unknown) => void logAxiomError(error, { name: 'image-models-reindex' });

async function queueModels({ tagWrites = [], levelImageIds = [] }: ImageChildTagChanges) {
  const imageIds = new Set(tagWrites.filter((x) => childTagIds.has(x.tagId)).map((x) => x.imageId));

  const levelOnly = [...new Set(levelImageIds)].filter((id) => !imageIds.has(id));
  if (levelOnly.length) {
    const tagged = await dbWrite
      .selectFrom('TagsOnImageNew')
      .select('imageId')
      .distinct()
      .where('imageId', 'in', levelOnly)
      .where('tagId', 'in', CHILD_TAG_IDS)
      .execute();
    for (const { imageId } of tagged) imageIds.add(imageId);
  }

  if (!imageIds.size) return;
  const rows = await dbWrite
    .selectFrom('Image as i')
    .innerJoin('Post as p', 'p.id', 'i.postId')
    .innerJoin('ModelVersion as mv', 'mv.id', 'p.modelVersionId')
    .select(['p.modelVersionId as modelVersionId', 'mv.modelId as modelId'])
    .distinct()
    .where('i.id', 'in', [...imageIds])
    .execute();
  if (!rows.length) return;

  const modelVersionIds = [...new Set(rows.map((r) => r.modelVersionId).filter(isId))];
  // A failed bust must not cost the other one or the queue.
  await Promise.all([
    bustCachedObject(REDIS_KEYS.CACHES.TAG_IDS_FOR_IMAGES, [...imageIds]).catch(logError),
    bustCachedObject(REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION, modelVersionIds).catch(logError),
  ]);
  await syncSearchIndexBulk({
    entityType: 'model',
    entityIds: [...new Set(rows.map((r) => r.modelId))],
    action: 'update',
  });
}

const isId = (x: number | null): x is number => x != null;
