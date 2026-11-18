import { REDIS_KEYS } from '@civitai/redis';
import { childBrowsingTagIds } from '@civitai/shared';
import { logAxiomError } from './axiom';
import { bustCachedObject } from './cache';
import { dbWrite } from './db';
import { syncSearchIndexBulk } from './search-index';
import { parkModelSearchUpdates } from './search-index-park';

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
 * For this app's tag, level and minor-flag writes: drops the cached tags and showcase images of the models whose
 * posts hold these images, then queues those models for a models-index rewrite. Never throws: it runs
 * after the tag, level or minor-flag write has committed. A failed attempt, the queue call included, is retried
 * once; a second failure is logged, with the image and model ids, and the models found are parked for
 * the main app to replay.
 */
export async function queueModelsForImageChildTagChanges(
  changes: ImageChildTagChanges
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const found: Found = {};
    try {
      return await queueModels(changes, found);
    } catch (error) {
      void logAxiomError(error, {
        name: 'image-models-reindex',
        attempt,
        dropped: attempt >= ATTEMPTS,
        imageIds: found.imageIds ?? changedImageIds(changes),
        modelIds: found.modelIds,
      });
      if (attempt >= ATTEMPTS) return parkModelSearchUpdates(found.modelIds ?? []);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

const ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
const logError = (error: unknown) => void logAxiomError(error, { name: 'image-models-reindex' });

/** What an attempt resolved before it failed, for the error log. */
type Found = { imageIds?: number[]; modelIds?: number[] };

const changedImageIds = ({
  tagWrites = [],
  levelImageIds = [],
  minorImageIds = [],
}: ImageChildTagChanges) => [
  ...new Set([...tagWrites.map((x) => x.imageId), ...levelImageIds, ...minorImageIds]),
];

async function queueModels(
  { tagWrites = [], levelImageIds = [], minorImageIds = [] }: ImageChildTagChanges,
  found: Found
) {
  const imageIds = new Set([
    ...tagWrites.filter((x) => childTagIds.has(x.tagId)).map((x) => x.imageId),
    ...minorImageIds,
  ]);

  const levelOnly = [...new Set(levelImageIds)].filter((id) => !imageIds.has(id));
  if (levelOnly.length) {
    const tagged = await dbWrite
      .selectFrom('TagsOnImageNew')
      .select('imageId')
      .where('imageId', 'in', levelOnly)
      .where('tagId', 'in', CHILD_TAG_IDS)
      .union(
        dbWrite
          .selectFrom('Image')
          .select('id as imageId')
          .where('id', 'in', levelOnly)
          .where('minor', '=', true)
      )
      .execute();
    for (const { imageId } of tagged) imageIds.add(imageId);
  }

  if (!imageIds.size) return;
  found.imageIds = [...imageIds];
  const rows = await dbWrite
    .selectFrom('Image as i')
    .innerJoin('Post as p', 'p.id', 'i.postId')
    .innerJoin('ModelVersion as mv', 'mv.id', 'p.modelVersionId')
    .select(['p.modelVersionId as modelVersionId', 'mv.modelId as modelId'])
    .distinct()
    .where('i.id', 'in', [...imageIds])
    .execute();
  if (!rows.length) return;
  found.modelIds = [...new Set(rows.map((r) => r.modelId))];

  const modelVersionIds = [...new Set(rows.map((r) => r.modelVersionId).filter(isId))].sort(
    (a, b) => a - b
  );
  // A failed bust must not cost the other one or the queue.
  await Promise.all([
    bustCachedObject(REDIS_KEYS.CACHES.TAG_IDS_FOR_IMAGES, [...imageIds]).catch(logError),
    bustCachedObject(REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION, modelVersionIds).catch(logError),
  ]);
  await syncSearchIndexBulk(
    {
      entityType: 'model',
      entityIds: found.modelIds,
      action: 'update',
    },
    { strict: true }
  );
}

const isId = (x: number | null): x is number => x != null;
