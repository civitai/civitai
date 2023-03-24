import {
  isImageResource,
  IngestImageInput,
  ingestImageSchema,
  GetInfiniteImagesInput,
  GetImageInput,
} from './../schema/image.schema';
import {
  ImageGenerationProcess,
  ModelStatus,
  Prisma,
  ReportReason,
  ReportStatus,
  ReviewReactions,
  TagType,
} from '@prisma/client';
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
import { simpleTagSelect, imageTagSelect, ImageTag } from '~/server/selectors/tag.selector';
import { getImageV2Select, ImageV2Model } from '~/server/selectors/imagev2.selector';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

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
  excludedImageIds,
  isFeatured,
  types,
  browsingMode,
  tagReview,
  needsReview,
}: GetGalleryImageInput & { orderBy?: TOrderBy; user?: SessionUser }) => {
  const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
  const isMod = user?.isModerator ?? false;
  needsReview = isMod ? needsReview : false;
  tagReview = isMod ? tagReview : false;

  const conditionalFilters: Prisma.Enumerable<Prisma.ImageWhereInput> = [];
  if (!!excludedTagIds?.length)
    conditionalFilters.push({ tags: { none: { tagId: { in: excludedTagIds } } } });

  if (!!tags?.length) conditionalFilters.push({ tags: { some: { tagId: { in: tags } } } });
  else if (!needsReview && !tagReview) {
    const periodStart = decreaseDate(new Date(), 3, 'days');
    conditionalFilters.push({ featuredAt: { gt: periodStart } });
  }

  if (isFeatured) conditionalFilters.push({ featuredAt: { not: null } });

  if (!!excludedUserIds?.length) conditionalFilters.push({ userId: { notIn: excludedUserIds } });

  if (!!excludedImageIds?.length) conditionalFilters.push({ id: { notIn: excludedImageIds } });

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
    id: excludedImageIds?.length ? { notIn: excludedImageIds } : undefined,
  };

  if (canViewNsfw && !browsingMode) browsingMode = BrowsingMode.All;
  else if (!canViewNsfw) browsingMode = BrowsingMode.SFW;

  let where: Prisma.ImageWhereInput = {};
  if (needsReview) where.needsReview = true;
  else if (tagReview) where.tags = { some: { needsReview: true } };
  else {
    where = {
      userId,
      nsfw: browsingMode === BrowsingMode.All ? undefined : browsingMode === BrowsingMode.NSFW,
      tosViolation: !isMod ? false : undefined,
      OR: [{ needsReview: false }, { userId: user?.id }],
      ...(infinite ? infiniteWhere : finiteWhere),
    };
  }

  const items = await dbRead.image.findMany({
    cursor: cursor ? { id: cursor } : undefined,
    take: limit,
    where,
    select: imageGallerySelect({ user }),
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

export const imageUrlInUse = async ({ url, id }: { url: string; id: number }) => {
  const otherImagesWithSameUrl = await dbWrite.image.count({
    where: {
      url: url,
      id: { not: id },
      connections: { modelId: { not: null } },
    },
  });

  return otherImagesWithSameUrl > 0;
};

export const deleteImageById = async ({ id }: GetByIdInput) => {
  try {
    const image = await dbRead.image.findUnique({ where: { id }, select: { url: true } });
    if (isProd && image && !imageUrlInUse({ url: image.url, id })) await deleteImage(image.url); // Remove from storage
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

export const moderateImages = async ({
  ids,
  nsfw,
  needsReview,
  delete: deleteImages,
}: {
  ids: number[];
  nsfw?: boolean;
  needsReview?: boolean;
  delete?: boolean;
}) => {
  if (deleteImages) {
    await Promise.all(ids.map((id) => deleteImageById({ id })));
  } else {
    await dbWrite.image.updateMany({
      where: { id: { in: ids } },
      data: { nsfw, needsReview },
    });
  }
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
        where: { disabled: false },
        select: {
          automated: true,
          tag: {
            select: simpleTagSelect,
          },
        },
      },
    },
  });
};

export type ImageScanResultResponse = {
  ok: boolean;
  error?: string;
  deleted?: boolean;
  blockedFor?: string[];
  tags?: { type: string; name: string }[];
};

export type IngestImageReturnType =
  | {
      type: 'error';
      data: { error: string };
    }
  | {
      type: 'blocked';
      data: { blockedFor?: string[]; tags?: { type: string; name: string }[] };
    }
  | {
      type: 'success';
      data: { tags: ImageTag[] };
    };

export const ingestImage = async ({
  image,
}: {
  image: IngestImageInput;
}): Promise<IngestImageReturnType> => {
  if (!env.IMAGE_SCANNING_ENDPOINT)
    throw new Error('missing IMAGE_SCANNING_ENDPOINT environment variable');
  const { url, id, width: oWidth, name } = ingestImageSchema.parse(image);
  const width = Math.min(oWidth ?? 450, 4096);
  const anim = name?.endsWith('.gif') ? false : undefined;
  const gamma = anim === false ? 0.99 : undefined;
  const edgeUrl = getEdgeUrl(url, { width, anim, gamma });

  const payload = {
    imageId: id,
    url: edgeUrl,
    wait: true,
    scans: [ImageScanType.Label, ImageScanType.Moderation],
  };

  await dbWrite.image.update({
    where: { id },
    data: { scanRequestedAt: new Date() },
    select: { id: true },
  });

  const { ok, deleted, blockedFor, tags, error } = (await fetch(env.IMAGE_SCANNING_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((res) => res.json())) as ImageScanResultResponse;

  if (deleted)
    return {
      type: 'blocked',
      data: { tags, blockedFor },
    };

  if (error) {
    return {
      type: 'error',
      data: { error },
    };
  }

  const imageTags = await dbWrite.tag.findMany({
    where: { tagsOnImage: { some: { imageId: id } } },
    select: imageTagSelect,
  });
  return {
    type: 'success',
    data: { tags: imageTags },
  };
};

// TODO.posts - remove when post implementation is fully ready
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
  modelVersionId,
  username,
  excludedTagIds,
  excludedUserIds,
  excludedImageIds,
  browsingMode,
  period,
  sort,
  userId,
  tags,
  generation,
  reviewId,
}: GetInfiniteImagesInput & { userId?: number }) => {
  const AND: string[] = [];
  let orderBy: string;

  // Filter to specific model/review content
  if (modelId || modelVersionId || reviewId) {
    const irhAnd = ['irh."imageId" = i.id'];
    if (modelVersionId) irhAnd.push(`irh."modelVersionId" = ${modelVersionId}`);
    if (modelId) irhAnd.push(`irh."modelId" = ${modelId}`);
    if (reviewId) irhAnd.push(`irh."reviewId" = ${reviewId}`);
    AND.push(`EXISTS (
      SELECT 1 FROM "ImageResourceHelper" irh
      WHERE ${irhAnd.join(' AND ')}
    )`);
  }

  // Filter to specific user content
  if (username) {
    AND.push(`u."username" = '${username}'`);
  }

  // Filter to specific tags
  if (tags?.length) {
    AND.push(`EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id AND toi."tagId" IN (${tags.join(', ')})
    )`);
  }

  // Filter to specific generation process
  if (generation?.length) {
    AND.push(`i."generationProcess" IN (${generation.map((g) => `'${g}'`).join(', ')})`);
  }

  // Filter to a specific post
  if (postId) {
    AND.push(`i."postId" = ${postId}`);
    orderBy = `i."index"`;
  } else {
    // Sort by selected sort
    if (sort === ImageSort.MostComments) orderBy = `r."commentCount${period}Rank"`;
    else if (sort === ImageSort.MostReactions) orderBy = `r."reactionCount${period}Rank"`;
    else orderBy = `i."id" DESC`;
  }

  // Exclude specific users
  if (excludedUserIds?.length) AND.push(`i."userId" NOT IN (${excludedUserIds.join(', ')})`);

  // Exclude specific images
  if (excludedImageIds?.length) AND.push(`i."id" NOT IN (${excludedImageIds.join(', ')})`);

  // Exclude specific tags
  if (excludedTagIds?.length) {
    const OR: string[] = [
      [
        `i."scannedAt" IS NOT NULL`,
        `NOT EXISTS (
          SELECT 1 FROM "TagsOnImage" toi
          WHERE toi."imageId" = i.id AND toi."tagId" IN (${excludedTagIds.join(', ')})
        )`,
      ].join(' AND '),
    ];
    if (userId) OR.push(`i."userId" = ${userId}`);
    AND.push(`(${OR.join(' OR ')})`);
  }

  const [cursorProp, cursorDirection] = orderBy?.split(' ');
  if (cursor) {
    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    if (cursorProp) AND.push(`${cursorProp} ${cursorOperator} ${cursor}`);
  }

  console.log('getAllImages start');
  console.time('getAllImages');
  const rawImages = await dbRead.$queryRawUnsafe<
    {
      id: number;
      name: string;
      url: string;
      nsfw: boolean;
      width: number;
      height: number;
      hash: string;
      meta: Prisma.JsonValue;
      hideMeta: boolean;
      generationProcess: ImageGenerationProcess;
      createdAt: Date;
      mimeType: string;
      scannedAt: Date;
      needsReview: boolean;
      userId: number;
      username: string | null;
      userImage: string | null;
      deletedAt: Date | null;
      cryCount: number;
      laughCount: number;
      likeCount: number;
      dislikeCount: number;
      heartCount: number;
      commentCount: number;
      reactions?: ReviewReactions[];
      cursorId?: bigint;
    }[]
  >(`
    SELECT
      i.id,
      i.name,
      i.url,
      i.nsfw,
      i.width,
      i.height,
      i.hash,
      i.meta,
      i."hideMeta",
      i."generationProcess",
      i."createdAt",
      i."mimeType",
      i."scannedAt",
      i."needsReview",
      i."userId",
      u.username,
      u.image "userImage",
      u."deletedAt",
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      ${!userId ? 'null' : 'ir.reactions'} "reactions",
      ${cursorProp ? cursorProp : 'null'} "cursorId"
    FROM "Image" i
    JOIN "User" u ON u.id = i."userId"
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = '${period}'
    LEFT JOIN "ImageRank" r ON r."imageId" = i.id
    ${
      !userId
        ? ''
        : `LEFT JOIN (
        SELECT "imageId", jsonb_agg(reaction) "reactions"
        FROM "ImageReaction"
        WHERE "userId" = ${userId}
        GROUP BY "imageId"
      ) ir ON ir."imageId" = i.id
    `
    }
    WHERE ${AND.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1}
  `);
  const images: ImageV2Model[] = rawImages.map(
    ({
      reactions,
      userId: creatorId,
      username,
      userImage,
      deletedAt,
      cryCount,
      likeCount,
      laughCount,
      dislikeCount,
      heartCount,
      commentCount,
      ...i
    }) => ({
      ...i,
      user: {
        id: creatorId,
        username,
        image: userImage,
        deletedAt,
      },
      stats: {
        cryCountAllTime: cryCount,
        laughCountAllTime: laughCount,
        likeCountAllTime: likeCount,
        dislikeCountAllTime: dislikeCount,
        heartCountAllTime: heartCount,
        commentCountAllTime: commentCount,
      },
      reactions: userId ? reactions?.map((r) => ({ userId, reaction: r })) ?? [] : [],
    })
  );
  console.timeEnd('getAllImages');

  let nextCursor: bigint | undefined;
  if (images.length > limit) {
    const nextItem = rawImages.pop();
    nextCursor = nextItem?.cursorId;
  }

  return {
    nextCursor,
    items: images,
  };
};

export const getImage = async ({ id, userId }: GetImageInput & { userId?: number }) => {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: getImageV2Select({ userId }),
  });
  if (!image) throw throwAuthorizationError();
  return image;
};

export const getImageResources = async ({ id }: GetByIdInput) => {
  return await dbRead.imageResourceHelper.findMany({
    where: { imageId: id },
    select: {
      reviewId: true,
      reviewRating: true,
      reviewDetails: true,
      reviewCreatedAt: true,
      name: true,
      modelVersionId: true,
      modelVersionName: true,
      modelVersionCreatedAt: true,
      modelId: true,
      modelName: true,
      modelRating: true,
      modelRatingCount: true,
      modelDownloadCount: true,
      modelCommentCount: true,
      modelFavoriteCount: true,
      modelType: true,
    },
  });
};

export const getImagesForModelVersion = async ({
  modelVersionIds,
  excludedTagIds,
  excludedIds,
  excludedUserIds,
}: {
  modelVersionIds: number | number[];
  excludedTagIds?: number[];
  excludedIds?: number[];
  excludedUserIds?: number[];
}) => {
  if (!Array.isArray(modelVersionIds)) modelVersionIds = [modelVersionIds];
  const imageWhere = [`iom."modelVersionId" IN (${modelVersionIds.join(',')})`];
  if (!!excludedTagIds?.length) {
    imageWhere.push(`i."scannedAt" IS NOT NULL`);
    const excludedTags = excludedTagIds.join(',');
    imageWhere.push(
      `NOT EXISTS (SELECT 1 FROM "TagsOnImage" toi WHERE toi."imageId" = iom."imageId" AND toi.disabled = false AND toi."tagId" IN (${excludedTags}) )`
    );
  }
  if (!!excludedIds?.length) {
    imageWhere.push(`iom."imageId" NOT IN (${excludedIds.join(',')})`);
  }
  if (!!excludedUserIds?.length) {
    imageWhere.push(`i."userId" NOT IN (${excludedUserIds.join(',')})`);
  }
  const images = await dbRead.$queryRawUnsafe<
    {
      id: number;
      name: string;
      url: string;
      nsfw: boolean;
      width: number;
      height: number;
      hash: string;
      modelVersionId: number;
    }[]
  >(`
    WITH targets AS (
      SELECT
        iom."modelVersionId",
        MIN(iom.index) "index"
      FROM "ImagesOnModels" iom
      JOIN "Image" i ON i.id = iom."imageId"
      WHERE ${imageWhere.join(' AND ')}
      GROUP BY iom."modelVersionId"
    )
    SELECT
      i.id,
      i.name,
      i.url,
      i.nsfw,
      i.width,
      i.height,
      i.hash,
      t."modelVersionId"
    FROM targets t
    JOIN "ImagesOnModels" iom ON iom.index = t.index AND iom."modelVersionId" = t."modelVersionId"
    JOIN "Image" i ON i.id = iom."imageId";
  `);

  return images;
};

export const getImagesForPosts = async ({
  postIds,
  excludedTagIds,
  excludedIds,
  excludedUserIds,
  userId,
}: {
  postIds: number | number[];
  excludedTagIds?: number[];
  excludedIds?: number[];
  excludedUserIds?: number[];
  userId?: number;
}) => {
  if (!Array.isArray(postIds)) postIds = [postIds];
  const imageWhere = [`i."postId" IN (${postIds.join(',')})`];
  if (!!excludedTagIds?.length) {
    imageWhere.push(`i."scannedAt" IS NOT NULL`);
    const excludedTags = excludedTagIds.join(',');
    imageWhere.push(
      `NOT EXISTS ( SELECT 1 FROM "TagsOnImage" toi WHERE toi."imageId" = i."id" AND toi.disabled = false AND toi."tagId" IN (${excludedTags}) )`
    );
  }
  if (!!excludedIds?.length) {
    imageWhere.push(`i."id" NOT IN (${excludedIds.join(',')})`);
  }
  if (!!excludedUserIds?.length) {
    imageWhere.push(`i."userId" NOT IN (${excludedUserIds.join(',')})`);
  }
  const images = await dbRead.$queryRawUnsafe<
    {
      id: number;
      name: string;
      url: string;
      nsfw: boolean;
      width: number;
      height: number;
      hash: string;
      postId: number;
      cryCount: number;
      laughCount: number;
      likeCount: number;
      dislikeCount: number;
      heartCount: number;
      commentCount: number;
      reactions?: ReviewReactions[];
    }[]
  >(`
    WITH targets AS (
      SELECT
        i."postId",
        MIN(i.index) "index"
      FROM "Image" i
      WHERE ${imageWhere.join(' AND ')}
      GROUP BY i."postId"
    )
    SELECT
      i.id,
      i.name,
      i.url,
      i.nsfw,
      i.width,
      i.height,
      i.hash,
      t."postId",
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      ${!userId ? 'null' : 'ir.reactions'} "reactions"
    FROM targets t
    JOIN "Image" i ON i."postId" = t."postId" AND i.index = t.index
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'
    ${
      !userId
        ? ''
        : `
    LEFT JOIN (
      SELECT "imageId", jsonb_agg(reaction) "reactions"
      FROM "ImageReaction"
      WHERE "userId" = ${userId}
      GROUP BY "imageId"
    ) ir ON ir."imageId" = i.id
    `
    }
  `);

  return images.map(({ reactions, ...i }) => ({
    ...i,
    reactions: reactions?.map((r) => ({ userId, reaction: r })) ?? [],
  }));
};
// #endregion
