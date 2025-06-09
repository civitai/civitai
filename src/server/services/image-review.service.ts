import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

/* ImageForReview */
export async function createImageForReview({
  imageId,
  reason,
}: {
  imageId: number;
  reason: string;
}) {
  await dbWrite.$queryRaw`
    INSERT INTO "ImageForReview" ("imageId", "reason")
    VALUES (${imageId}, ${reason})
    ON CONFLICT DO NOTHING;
  `;
}

export async function deleteImageForReviewMultiple(ids: number[]) {
  if (!ids.length) return;
  await dbWrite.$queryRaw`
    DELETE FROM "ImageForReview"
    WHERE "imageId" IN (${Prisma.join(ids)})
  `;
}

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
