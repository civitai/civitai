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

export const getGalleryImages = async <
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
  infinite,
}: GetGalleryImageInput & { orderBy?: TOrderBy; user?: SessionUser }) => {
  const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;

  const infiniteWhere: Prisma.ImageWhereInput = {
    connections: {
      modelId,
      modelVersionId,
      reviewId,
    },
  };
  const finiteWhere: Prisma.ImageWhereInput = {
    imagesOnModels:
      modelVersionId || modelId
        ? { modelVersionId, modelVersion: modelId ? { modelId } : undefined }
        : undefined,
    imagesOnReviews: reviewId ? { reviewId } : undefined,
  };

  return await prisma.image.findMany({
    cursor: cursor ? { id: cursor } : undefined,
    take: limit,
    where: {
      userId,
      nsfw: !canViewNsfw ? { equals: false } : undefined,
      ...(infinite ? infiniteWhere : finiteWhere),
      // TODO.gallery - excludedTagIds (hidden tags)
    },
    select: imageGallerySelect,
    orderBy: orderBy ?? { createdAt: 'desc' },
  });
};
