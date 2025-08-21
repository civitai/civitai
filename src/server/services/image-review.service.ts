import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

/* ImageTagForReview */
export async function createImageTagsForReview({
  imageId,
  tagIds,
}: {
  imageId: number;
  tagIds: number[];
}) {
  if (!tagIds.length) return;
  const values = tagIds.map((tagId) => `(${imageId}, ${tagId})`).join(', ');

  await dbWrite.$queryRawUnsafe(`
    INSERT INTO "ImageTagForReview" ("imageId", "tagId")
    VALUES ${values}
    ON CONFLICT DO NOTHING;
  `);
}

export async function deleteImagTagsForReviewByImageIds(imageIds: number[]) {
  if (!imageIds.length) return;
  await dbWrite.$queryRaw`
    DELETE FROM "ImageTagForReview"
    WHERE "imageId" IN (${Prisma.join(imageIds)})
  `;
}

export async function getImagTagsForReviewByImageIds(imageIds: number[]) {
  if (!imageIds.length) return [];
  return await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    SELECT "imageId", "tagId" FROM "ImageTagForReview"
    WHERE "imageId" IN (${Prisma.join(imageIds)})
  `;
}
