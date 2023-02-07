import { Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { ImageSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetGalleryImageInput } from '~/server/schema/image.schema';
import { imageGallerySelect, imageSelect } from '~/server/selectors/image.selector';

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
  return result.map((x) => x.image);
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
  period,
  sort,
}: GetGalleryImageInput & { orderBy?: TOrderBy; user?: SessionUser }) => {
  const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;

  const infiniteWhere: Prisma.ImageFindManyArgs['where'] = {
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

  const items = await prisma.image.findMany({
    cursor: cursor ? { id: cursor } : undefined,
    take: limit,
    where: {
      userId,
      nsfw: !canViewNsfw ? { equals: false } : undefined,
      tosViolation: false,
      ...(infinite ? infiniteWhere : finiteWhere),
      // TODO.gallery - excludedTagIds (hidden tags)
    },
    select: imageGallerySelect({ user }),
    orderBy: orderBy ?? [
      // ...(sort === ImageSort.MostComments
      //   ? [{ ranks: { [`commentCount${period}Rank`]: 'asc' } }]
      //   : []),
      { createdAt: 'desc' },
    ],
  });

  return items.map(({ stats, ...image }) => ({
    ...image,
    metrics: {
      likeCount: stats?.likeCountAllTime,
      dislikeCount: stats?.dislikeCountAllTime,
      laughCount: stats?.laughCountAllTime,
      cryCount: stats?.cryCountAllTime,
      heartCount: stats?.heartCountAllTime,
      commentCount: stats?.commentCountAllTime,
    },
  }));
};

export const deleteImageById = ({ id }: GetByIdInput) => {
  return prisma.image.delete({ where: { id } });
};
