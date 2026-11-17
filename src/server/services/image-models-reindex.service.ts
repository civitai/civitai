import { Prisma } from '@prisma/client';
import { childBrowsingTagIds } from '@civitai/shared';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';

const CHILD_TAG_IDS = [...childBrowsingTagIds];
const childTagIds = new Set<number>(CHILD_TAG_IDS);

/**
 * Queue a models-index rewrite for the models whose posts hold these images, after dropping their
 * cached showcase images. The models sync re-picks a model only when `Model.updatedAt` moves, so a
 * change to an image's child browsing tags or nsfwLevel reaches its document only through here.
 *
 * - `tagWrites`: images whose tags were written; those that gained or lost a child tag are queued.
 * - `levelImageIds`: images whose nsfwLevel may have changed; queued while they carry a child tag.
 */
export async function queueModelsForImageChildTagChanges({
  tagWrites = [],
  levelImageIds = [],
}: {
  tagWrites?: { imageId: number; tagId: number }[];
  levelImageIds?: number[];
}) {
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
  const rows = await dbRead.$queryRaw<{ modelVersionId: number; modelId: number }[]>(Prisma.sql`
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
  // The index reads each image's nsfwLevel from this day-long cache; its tags are read fresh.
  await imagesForModelVersionsCache.bust([...new Set(rows.map((r) => r.modelVersionId))]);
  await modelsSearchIndex.queueUpdate(
    [...new Set(rows.map((r) => r.modelId))].map((id) => ({
      id,
      action: SearchIndexUpdateQueueAction.Update,
    }))
  );
}
