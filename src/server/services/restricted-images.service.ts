import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { matureRestrictedBaseModels } from '~/shared/constants/basemodel.constants';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { queueDocumentsForImageMinorChanges } from '~/server/services/image-models-reindex.service';
import { chunkIds } from '~/utils/array-helpers';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;
type FlagResult = {
  flagged: number;
  postIds: number[];
  imageIds: number[];
  matureImageIds: number[];
};

const IMAGES_PER_REINDEX = 500;

/**
 * After images are newly restricted: for the mature ones, which the restriction hides, queue every
 * search document that shows them and take them out of the image queues (cached thumbnails, rating
 * pools), in batches. Never throws, and logs counts only: the flags are already committed.
 */
export async function reindexRestrictedImages(
  { imageIds, matureImageIds }: Pick<FlagResult, 'imageIds' | 'matureImageIds'>,
  source: string
) {
  if (!imageIds.length) return;
  try {
    await reindexInBatches(imageIds, new Set(matureImageIds), source);
  } catch (error) {
    logToAxiom(
      {
        name: 'restricted-images',
        type: 'error',
        message: 'Search reindex failed',
        source,
        images: imageIds.length,
        error: (error as Error).message,
      },
      'webhooks'
    );
  }
}

async function reindexInBatches(imageIds: number[], mature: Set<number>, source: string) {
  // Dynamic: image.service imports this module.
  const { queueImageSearchIndexUpdate } = await import('~/server/services/image.service');
  let failedBatches = 0;
  // Only the images the restriction hides change what anything serves.
  for (const ids of chunkIds([...mature], IMAGES_PER_REINDEX)) {
    // One retry: a later run never selects these images again.
    const remove = () =>
      queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Delete });
    await remove()
      .catch(remove)
      .catch(() => failedBatches++);
    await queueDocumentsForImageMinorChanges({ minorImageIds: ids });
  }
  logToAxiom(
    {
      name: 'restricted-images',
      type: 'info',
      message: 'Restricted images reindexed',
      source,
      images: imageIds.length,
      matureImages: mature.size,
    },
    'webhooks'
  );
  if (failedBatches)
    logToAxiom(
      {
        name: 'restricted-images',
        type: 'error',
        message: 'Image queue removal failed',
        source,
        images: imageIds.length,
        failedBatches,
      },
      'webhooks'
    );
}

/** Versions whose base model restricts mature `images`, optionally only those `among`. */
export async function getRestrictedModelVersionIds(db: Db, among?: number[]): Promise<number[]> {
  const baseModels = matureRestrictedBaseModels('images');
  // `Prisma.join([])` throws.
  if (!baseModels.length || (among && !among.length)) return [];
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT id
    FROM "ModelVersion"
    WHERE "baseModel" IN (${Prisma.join(baseModels)})
    ${among ? Prisma.sql`AND id IN (${Prisma.join(among)})` : Prisma.empty}
    ORDER BY id
  `;
  return rows.map((r) => r.id);
}

/**
 * Sets `Image."modelRestricted"` on images with a resource on `modelVersionIds`, which the caller
 * has already resolved through `getRestrictedModelVersionIds`. Hide-only: it never clears the flag,
 * because un-hiding is a moderation decision. Returns how many images it changed and their posts,
 * whose cached version showcases the caller must refresh.
 */
export async function flagRestrictedImages(
  db: Db,
  { modelVersionIds, imageIds }: { modelVersionIds: number[]; imageIds?: number[] }
): Promise<FlagResult> {
  if (!modelVersionIds.length || (imageIds && !imageIds.length))
    return { flagged: 0, postIds: [], imageIds: [], matureImageIds: [] };
  // 🔴 `EXCEPT` against `idx_image_restricted_true`, not a `modelRestricted` filter on the joined
  // row: the filter runs after a random `Image_pkey` probe per candidate, while the `EXCEPT` is two
  // index-only scans. With `imageIds` the candidates are already a handful of key probes.
  //
  // 🔴 `flagged` must stay the UPDATE's rowcount and never become the subquery's.
  // `ImageResourceNew` has no enforced foreign key, so resource rows naming a deleted image survive
  // every reconcile run; counting the read would give the drift gauge a permanent floor.
  const [result] = await db.$queryRaw<FlagResult[]>`
    WITH updated AS (
      UPDATE "Image" i
      SET "modelRestricted" = true
      WHERE i."modelRestricted" IS DISTINCT FROM true
        AND i.id IN (
          SELECT irn."imageId"
          FROM "ImageResourceNew" irn
          WHERE irn."modelVersionId" IN (${Prisma.join(modelVersionIds)})
          ${
            imageIds
              ? Prisma.sql`AND irn."imageId" IN (${Prisma.join(imageIds)})`
              : Prisma.sql`EXCEPT SELECT id FROM "Image" WHERE "modelRestricted" = true`
          }
        )
      RETURNING i.id, i."postId", i."nsfwLevel"
    )
    SELECT
      count(*)::int AS flagged,
      COALESCE(array_agg(DISTINCT "postId") FILTER (WHERE "postId" IS NOT NULL), '{}') AS "postIds",
      COALESCE(array_agg(id ORDER BY id), '{}') AS "imageIds",
      COALESCE(
        array_agg(id ORDER BY id) FILTER (WHERE ("nsfwLevel" & ${nsfwBrowsingLevelsFlag}) != 0),
        '{}'
      ) AS "matureImageIds"
    FROM updated
  `;
  return {
    flagged: result?.flagged ?? 0,
    postIds: result?.postIds ?? [],
    imageIds: result?.imageIds ?? [],
    matureImageIds: result?.matureImageIds ?? [],
  };
}

/**
 * The write-path form of the restricted-base-model rule: call it whenever resources on
 * `modelVersionIds` are written for `imageIds` (all of the versions' images when omitted).
 * Logged, not thrown: the resources are already written, and the reconcile job applies the same
 * rule, so a failure here must not fail the write. Not for use inside a transaction, where a
 * failed statement aborts it anyway.
 */
export async function flagImagesOnRestrictedVersions({
  modelVersionIds,
  imageIds,
}: {
  modelVersionIds: number[];
  imageIds?: number[];
}): Promise<FlagResult> {
  try {
    const restricted = await getRestrictedModelVersionIds(dbWrite, modelVersionIds);
    const result = await flagRestrictedImages(dbWrite, { modelVersionIds: restricted, imageIds });
    // Not awaited: a large version merge flags many images, and the reindex never throws.
    void reindexRestrictedImages(result, 'resource-write');
    return result;
  } catch (error) {
    logToAxiom(
      {
        name: 'restricted-images',
        type: 'error',
        message: 'Failed to flag restricted images',
        modelVersionIds,
        imageIds,
        error: (error as Error).message,
      },
      'webhooks'
    );
    return { flagged: 0, postIds: [], imageIds: [], matureImageIds: [] };
  }
}
