import { ModelStatus, Prisma, ReportReason, ReportStatus } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { ImageSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetGalleryImageInput } from '~/server/schema/image.schema';
import { imageGallerySelect, imageSelect } from '~/server/selectors/image.selector';

export const getModelVersionImages = async ({ modelVersionId }: { modelVersionId: number }) => {
  const result = await prisma.imagesOnModels.findMany({
    where: { modelVersionId, image: { tosViolation: false } },
    select: { image: { select: imageSelect } },
  });
  return result.map((x) => x.image);
};

export const getReviewImages = async ({ reviewId }: { reviewId: number }) => {
  const result = await prisma.imagesOnReviews.findMany({
    where: { reviewId, image: { tosViolation: false } },
    select: { image: { select: imageSelect } },
  });
  return result.map((x) => x.image);
};

/**
 * TODO.gallery
 * Filter images based on selected filters (image processing, resources, single image per model/album)
 * @justin Add "featured" filter when no category has been selected
 */
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
  tags,
  excludedTagIds,
  excludedUserIds,
  singleImageAlbum,
  singleImageModel,
}: GetGalleryImageInput & { orderBy?: TOrderBy; user?: SessionUser }) => {
  const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;
  const isMod = user?.isModerator ?? false;

  const infiniteWhere: Prisma.ImageFindManyArgs['where'] = {
    connections: {
      modelId,
      modelVersionId,
      reviewId,
    },
    // Only include images from published models and without tosViolation
    imagesOnModels: {
      modelVersion: { model: { status: ModelStatus.Published, tosViolation: false } },
    },
  };
  const finiteWhere: Prisma.ImageWhereInput = {
    imagesOnModels:
      modelVersionId || modelId
        ? { modelVersionId, modelVersion: modelId ? { modelId } : undefined }
        : undefined,
    imagesOnReviews: reviewId ? { reviewId } : undefined,
  };

  const conditionalFilters: Prisma.Enumerable<Prisma.ImageWhereInput> = [];
  if (excludedTagIds && excludedTagIds.length)
    conditionalFilters.push({ tags: { every: { tagId: { notIn: excludedTagIds } } } });

  if (tags && tags.length) conditionalFilters.push({ tags: { some: { tagId: { in: tags } } } });

  if (excludedUserIds && excludedUserIds.length)
    conditionalFilters.push({ userId: { notIn: excludedUserIds } });

  const items = await prisma.image.findMany({
    cursor: cursor ? { id: cursor } : undefined,
    take: limit,
    where: {
      userId,
      nsfw: !canViewNsfw ? { equals: false } : undefined,
      tosViolation: !isMod ? false : undefined,
      AND: conditionalFilters,
      ...(infinite ? infiniteWhere : finiteWhere),
    },
    select: imageGallerySelect({ user }),
    orderBy: orderBy ?? [
      ...(sort === ImageSort.MostComments
        ? [{ rank: { [`commentCount${period}Rank`]: 'asc' } }]
        : sort === ImageSort.MostReactions // TODO.gallery: @justin Add metric to sort by most reactions
        ? [{ rank: { [`likeCount${period}Rank`]: 'asc' } }]
        : []),
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

export const updateImageById = <TSelect extends Prisma.ImageSelect>({
  id,
  select,
  data,
}: {
  id: number;
  data: Prisma.ImageUpdateArgs['data'];
  select: TSelect;
}) => {
  return prisma.image.update({ where: { id }, data, select });
};

export const updateImageReportStatusByReason = ({
  id,
  reason,
  status,
}: {
  id: number;
  reason: ReportReason;
  status: ReportStatus;
}) => {
  return prisma.report.updateMany({
    where: { reason, image: { imageId: id } },
    data: { status },
  });
};
