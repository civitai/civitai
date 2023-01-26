import { SessionUser } from 'next-auth';
import { GetGalleryImageInput } from './../schema/image.schema';
import { prisma } from '~/server/db/client';
import { imageGallerySelect, imageSelect } from '~/server/selectors/image.selector';
import { Prisma } from '@prisma/client';
import { env } from '~/env/server.mjs';

export const getModelVersionImages = async ({ modelVersionId }: { modelVersionId: number }) => {
  const result = await prisma.imagesOnModels.findMany({
    where: { modelVersionId },
    select: { image: { select: imageSelect } },
  });
  return result.map((x) => x.image);
};

export const getReviewImages = async ({ reviewId }: { reviewId: number }) => {
  const result = await prisma.imagesOnReviews.findMany({
    where: { reviewId },
    select: { image: { select: imageSelect } },
  });
  return await result.map((x) => x.image);
};

export const getImages = async <
  TOrderBy extends Prisma.Enumerable<Prisma.ImageOrderByWithRelationInput>
>({
  limit,
  cursor,
  modelId,
  modelVersionId,
  reviewId,
  userId,
  user,
  orderBy,
}: GetGalleryImageInput & { orderBy?: TOrderBy; user?: SessionUser }) => {
  const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;
  return await prisma.image.findMany({
    cursor: cursor ? { id: cursor } : undefined,
    take: limit,
    where: {
      // query modelId or modelVersionId
      userId,
      imagesOnModels:
        modelVersionId || modelId
          ? { modelVersionId, modelVersion: modelId ? { modelId } : undefined }
          : undefined,
      imagesOnReviews: reviewId ? { reviewId } : undefined,
      nsfw: !canViewNsfw ? { equals: false } : undefined,
      // TODO - excludedTagIds (hidden tags)
    },
    select: imageGallerySelect,
    orderBy: orderBy ?? { createdAt: 'desc' },
  });
};
