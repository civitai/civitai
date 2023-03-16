import {
  isImageResource,
  IngestImageInput,
  ingestImageSchema,
  GetInfiniteImagesInput,
  GetImageInput,
} from './../schema/image.schema';
import { ModelStatus, Prisma, ReportReason, ReportStatus } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { isProd } from '~/env/other';

import { env } from '~/env/server.mjs';
import { BrowsingMode, ImageScanType, ImageSort } from '~/server/common/enums';
import { dbWrite, dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetGalleryImageInput,
  GetImageConnectionsSchema,
  UpdateImageInput,
} from '~/server/schema/image.schema';
import { imageGallerySelect, imageSelect } from '~/server/selectors/image.selector';
import { deleteImage } from '~/utils/cf-images-utils';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { decreaseDate } from '~/utils/date-helpers';
import { simpleTagSelect, imageTagSelect } from '~/server/selectors/tag.selector';
import { getImageV2Select } from '~/server/selectors/imagev2.selector';

export const getModelVersionImages = async ({ modelVersionId }: { modelVersionId: number }) => {
  const result = await dbRead.imagesOnModels.findMany({
    where: { modelVersionId, image: { tosViolation: false, needsReview: false } },
    select: { image: { select: imageSelect } },
  });
  return result.map((x) => x.image);
};

export const getReviewImages = async ({ reviewId }: { reviewId: number }) => {
  const result = await dbRead.imagesOnReviews.findMany({
    where: { reviewId, image: { tosViolation: false, needsReview: false } },
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
  tags,
  excludedTagIds,
  excludedUserIds,
  isFeatured,
  types,
  browsingMode,
  needsReview,
}: GetGalleryImageInput & { orderBy?: TOrderBy; user?: SessionUser }) => {
  const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
  const isMod = user?.isModerator ?? false;
  needsReview = isMod ? needsReview : false;

  const conditionalFilters: Prisma.Enumerable<Prisma.ImageWhereInput> = [];
  if (!!excludedTagIds?.length)
    conditionalFilters.push({ tags: { none: { tagId: { in: excludedTagIds } } } });

  if (!!tags?.length) conditionalFilters.push({ tags: { some: { tagId: { in: tags } } } });
  else if (!needsReview) {
    const periodStart = decreaseDate(new Date(), 3, 'days');
    conditionalFilters.push({ featuredAt: { gt: periodStart } });
  }

  if (isFeatured) conditionalFilters.push({ featuredAt: { not: null } });

  if (!!excludedUserIds?.length) conditionalFilters.push({ userId: { notIn: excludedUserIds } });

  if (types && types.length) conditionalFilters.push({ generationProcess: { in: types } });

  const infiniteWhere: Prisma.ImageFindManyArgs['where'] = {
    connections: {
      modelId,
      modelVersionId,
      reviewId,
    },
    OR: [
      {
        // Only include images from published models and without tosViolation
        imagesOnModels: {
          modelVersion: { model: { status: ModelStatus.Published, tosViolation: false } },
        },
      },
      {
        imagesOnReviews: { review: { tosViolation: false } },
      },
    ],
    AND: conditionalFilters.length ? conditionalFilters : undefined,
  };
  const finiteWhere: Prisma.ImageWhereInput = {
    imagesOnModels:
      modelVersionId || modelId
        ? { modelVersionId, modelVersion: modelId ? { modelId } : undefined }
        : undefined,
    imagesOnReviews: reviewId ? { reviewId } : undefined,
    tags: excludedTagIds?.length ? { none: { tagId: { in: excludedTagIds } } } : undefined,
  };

  if (canViewNsfw && !browsingMode) browsingMode = BrowsingMode.All;
  else if (!canViewNsfw) browsingMode = BrowsingMode.SFW;

  const items = await dbRead.image.findMany({
    cursor: cursor ? { id: cursor } : undefined,
    take: limit,
    where: needsReview
      ? { needsReview: true }
      : {
          userId,
          nsfw:
            browsingMode === BrowsingMode.All
              ? undefined
              : { equals: browsingMode === BrowsingMode.NSFW },
          tosViolation: !isMod ? false : undefined,
          OR: [{ needsReview: false }, { userId: user?.id }],
          ...(infinite ? infiniteWhere : finiteWhere),
        },
    select: imageGallerySelect({ user, needsReview }),
    orderBy: orderBy ?? [
      ...(sort === ImageSort.MostComments
        ? [{ rank: { [`commentCount${period}Rank`]: 'asc' } }]
        : sort === ImageSort.MostReactions
        ? [{ rank: { [`reactionCount${period}Rank`]: 'asc' } }]
        : []),
      { id: 'desc' },
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

export const deleteImageById = async ({ id }: GetByIdInput) => {
  try {
    const image = await dbRead.image.findUnique({ where: { id }, select: { url: true } });
    if (isProd && image) await deleteImage(image.url); // Remove from storage
  } catch {
    // Ignore errors
  }
  return await dbWrite.image.delete({ where: { id } });
};

// consider refactoring this endoint to only allow for updating `needsReview`, because that is all this endpoint is being used for...
export const updateImageById = <TSelect extends Prisma.ImageSelect>({
  id,
  select,
  data,
}: {
  id: number;
  data: Prisma.ImageUpdateArgs['data'];
  select: TSelect;
}) => {
  return dbWrite.image.update({ where: { id }, data, select });
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
  return dbWrite.report.updateMany({
    where: { reason, image: { imageId: id } },
    data: { status },
  });
};

export const getImageConnectionsById = ({ id, modelId, reviewId }: GetImageConnectionsSchema) => {
  return dbRead.image.findUnique({
    where: { id },
    select: {
      connections: {
        select: {
          imageId: true,
          model: modelId
            ? {
                select: {
                  id: true,
                  name: true,
                  type: true,
                  rank: {
                    select: {
                      downloadCountAllTime: true,
                      favoriteCountAllTime: true,
                      commentCountAllTime: true,
                      ratingCountAllTime: true,
                      ratingAllTime: true,
                    },
                  },
                },
              }
            : undefined,
          review: reviewId ? { select: { id: true } } : undefined,
        },
      },
    },
  });
};

export const updateImage = async (image: UpdateImageInput) => {
  await dbWrite.image.update({
    where: { id: image.id },
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      resources: image?.resources
        ? {
            deleteMany: {
              NOT: image.resources.filter(isImageResource).map(({ id }) => ({ id })),
            },
            connectOrCreate: image.resources.filter(isImageResource).map((resource) => ({
              where: { id: resource.id },
              create: resource,
            })),
          }
        : undefined,
    },
  });
};

export const getImageDetail = async ({ id }: GetByIdInput) => {
  return await dbWrite.image.findUnique({
    where: { id },
    select: {
      resources: {
        select: {
          id: true,
          modelVersion: { select: { id: true, name: true } },
          name: true,
          detected: true,
        },
      },
      tags: {
        select: {
          tag: {
            select: simpleTagSelect,
          },
          automated: true,
        },
      },
    },
  });
};

export const ingestImage = async ({ image }: { image: IngestImageInput }) => {
  if (!env.IMAGE_SCANNING_ENDPOINT)
    throw new Error('missing IMAGE_SCANNING_ENDPOINT environment variable');
  const { url, id, width: oWidth, name } = ingestImageSchema.parse(image);
  const width = Math.min(oWidth ?? 450, 4096);
  const anim = name?.endsWith('.gif') ? false : undefined;
  const gamma = anim === false ? 0.99 : undefined;
  const edgeUrl = getEdgeUrl(url, { width, anim, gamma });

  const callbackHost = 'https://1202-173-207-126-206.ngrok.io';
  const payload = {
    imageId: id,
    url: edgeUrl,
    wait: true,
    scans: [ImageScanType.Label, ImageScanType.Moderation],
    callbackUrl: `${callbackHost}/api/webhooks/image-scan-result?token=${env.WEBHOOK_TOKEN}`,
  };

  await dbWrite.image.update({
    where: { id },
    data: { scanRequestedAt: new Date() },
    select: { id: true },
  });

  await fetch(env.IMAGE_SCANNING_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const imageTags = await dbWrite.tag.findMany({
    where: { tagsOnImage: { some: { imageId: id } } },
    select: imageTagSelect,
  });
  return imageTags;
};

export const ingestNewImages = async ({
  reviewId,
  modelId,
}: {
  reviewId?: number;
  modelId?: number;
}) => {
  const images = await dbWrite.image.findMany({
    where: {
      imagesOnModels: modelId ? { modelVersion: { modelId } } : undefined,
      imagesOnReviews: reviewId ? { reviewId } : undefined,
      scanRequestedAt: null,
    },
    select: { id: true, url: true, width: true, name: true },
  });

  Promise.all(images.map((image) => ingestImage({ image })));
};

// #region [new service methods]
export type ImagesInfiniteModel = AsyncReturnType<typeof getAllImages>['items'][0];
export const getAllImages = async ({
  limit,
  cursor,
  postId,
  modelId,
  username,
  excludedTagIds,
  excludedUserIds,
  browsingMode,
  period,
  sort,
  userId,
  tags,
}: GetInfiniteImagesInput & { userId?: number }) => {
  const AND: Prisma.Enumerable<Prisma.ImageWhereInput> = [];
  if (postId) AND.push({ postId });
  if (modelId) AND.push({ resources: { some: { modelVersion: { modelId } } } });
  if (username) AND.push({ user: { username: { equals: username, mode: 'insensitive' } } });
  if (browsingMode !== BrowsingMode.All)
    AND.push({ nsfw: { equals: browsingMode === BrowsingMode.NSFW } });
  if (!!excludedUserIds?.length) AND.push({ userId: { notIn: excludedUserIds } });
  if (!!excludedTagIds?.length) {
    AND.push({
      OR: [
        { userId },
        { tags: !!excludedTagIds.length ? { none: { tagId: { in: excludedTagIds } } } : undefined },
      ],
    });
  }
  if (!!tags?.length) AND.push({ tags: { some: { tagId: { in: tags } } } });

  const orderBy: Prisma.Enumerable<Prisma.ImageOrderByWithRelationInput> = [];
  if (postId) orderBy.push({ index: 'asc' });
  else {
    if (sort === ImageSort.MostComments)
      orderBy.push({ rank: { [`commentCount${period}Rank`]: 'asc' } });
    else if (sort === ImageSort.MostReactions)
      orderBy.push({ rank: { [`reactionCount${period}Rank`]: 'asc' } });
    orderBy.push({ id: 'desc' });
  }

  const images = await dbRead.image.findMany({
    take: cursor ? limit + 1 : limit,
    cursor: cursor ? { id: cursor } : undefined,
    where: { AND },
    orderBy,
    select: getImageV2Select({ userId }),
  });

  let nextCursor: number | undefined;
  if (images.length > limit) {
    const nextItem = images.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: images,
  };
};

export const getImage = async ({
  id,
  excludedTagIds,
  excludedUserIds,
  browsingMode,
  userId,
}: GetImageInput & { userId?: number }) => {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: getImageV2Select({ userId }),
  });
};
// #endregion
