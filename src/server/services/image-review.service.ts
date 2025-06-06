// import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

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

export async function createImageTagsForReview({
  imageId,
  tagIds,
}: {
  imageId: number;
  tagIds: number[];
}) {
  if (!tagIds.length) return;
  await dbWrite.$queryRaw`
    INSERT INTO "ImageTagForReview" ("imageId", "tagId")
    VALUES ${tagIds.map((tagId) => `(${imageId}, ${tagId})`).join(', ')}
    ON CONFLICT DO NOTHING;
  `;
}
