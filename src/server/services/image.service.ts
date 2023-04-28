import {
  isImageResource,
  IngestImageInput,
  ingestImageSchema,
  GetInfiniteImagesInput,
  GetImageInput,
  RemoveImageResourceSchema,
  GetImagesByCategoryInput,
} from './../schema/image.schema';
import {
  CosmeticSource,
  CosmeticType,
  ImageGenerationProcess,
  ModelStatus,
  NsfwLevel,
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
import { VotableTagModel } from '~/libs/tags';
import { UserWithCosmetics, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getSystemTags, getTagsNeedingReview } from '~/server/services/system-cache';
import { redis } from '~/server/redis/client';
import { hashify, hashifyObject } from '~/utils/string-helpers';
import { TRPCError } from '@trpc/server';
import { applyUserPreferences, UserPreferencesInput } from '~/server/middleware.trpc';
import { nsfwLevelOrder } from '~/libs/moderation';
import { indexOfOr, shuffle } from '~/utils/array-helpers';
import { getTypeCategories } from '~/server/services/tag.service';

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

type GetGalleryImagesRaw = {
  id: number;
  name: string | null;
  url: string;
  nsfw: NsfwLevel;
  width: number | null;
  height: number | null;
  hash: string | null;
  meta: Prisma.JsonValue;
  generationProcess: ImageGenerationProcess | null;
  createdAt: Date;
  scannedAt: Date | null;
  needsReview: boolean;
  userId: number;
  index: number | null;
  modelId: number | null;
  reviewId: number | null;
  cryCount: number;
  laughCount: number;
  likeCount: number;
  dislikeCount: number;
  heartCount: number;
  commentCount: number;
  postId: number | null;
  reactions?: ReviewReactions[];
  cursorId?: bigint;
};
export const getGalleryImages = async ({
  limit,
  cursor,
  modelId,
  modelVersionId,
  reviewId,
  userId,
  user,
  infinite,
  period,
  sort,
  tags,
  excludedTagIds,
  excludedUserIds,
  excludedImageIds,
  isFeatured,
  types,
  tagReview,
  needsReview,
}: GetGalleryImageInput & { user?: SessionUser }) => {
  const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
  const isMod = user?.isModerator ?? false;
  needsReview = isMod ? needsReview : false;
  tagReview = isMod ? tagReview : false;

  const AND: Prisma.Sql[] = [];
  // Exclude TOS violations
  if (!isMod) AND.push(Prisma.sql`i."tosViolation" = false`);

  // Exclude images that need review
  if (!isMod) {
    const needsReviewOR = [
      Prisma.sql`i."needsReview" = false`,
      Prisma.sql`i."userId" = ${user?.id}`,
    ];
    AND.push(Prisma.sql`(${Prisma.join(needsReviewOR, ' OR ')})`);
  }

  // Exclude specific tags
  if (!!excludedTagIds?.length) {
    const OR = [
      Prisma.join(
        [
          Prisma.sql`i."scannedAt" IS NOT NULL`,
          Prisma.sql`NOT EXISTS (
          SELECT 1 FROM "TagsOnImage" toi
          WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(excludedTagIds)})
        )`,
        ],
        ' AND '
      ),
    ];
    if (userId) OR.push(Prisma.sql`i."userId" = ${userId}`);
    AND.push(Prisma.sql`(${Prisma.join(OR, ' OR ')})`);
  }

  // Filter to specific user
  if (userId) AND.push(Prisma.sql`i."userId" = ${userId}`);
  const targetedAlbum = !!(reviewId || modelVersionId || modelId);

  // Filter to specific tags
  if (!targetedAlbum && tags?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(tags)})
    )`);
  } else if (infinite && !needsReview && !tagReview) {
    const periodStart = decreaseDate(new Date(), 3, 'days');
    AND.push(Prisma.sql`i."featuredAt" > ${periodStart}`);
  }

  // Filter to featured images
  if (isFeatured) AND.push(Prisma.sql`i."featuredAt" IS NOT NULL`);

  // Exclude specific users
  if (!!excludedUserIds?.length)
    AND.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);

  // Exclude specific images
  if (!!excludedImageIds?.length)
    AND.push(Prisma.sql`i.id NOT IN (${Prisma.join(excludedImageIds)})`);

  // Filter to specific image generation types
  if (types && types.length) AND.push(Prisma.sql`i."generationProcess" IN (${Prisma.join(types)})`);

  // Filter to specific image connections
  const optionalRank = targetedAlbum;
  if (reviewId) AND.push(Prisma.sql`ior."reviewId" = ${reviewId}`);
  else if (modelVersionId) {
    AND.push(Prisma.sql`iom."modelVersionId" = ${modelVersionId}`);
    AND.push(Prisma.sql`ior."reviewId" IS NULL`);
  } else if (modelId) AND.push(Prisma.sql`m."id" = ${modelId}`);
  AND.push(Prisma.sql`(rev.id IS NULL OR rev."tosViolation" = false)`);

  let orderBy = 'i.id DESC';
  if (!infinite) orderBy = 'COALESCE(ior."index",iom."index",0)';
  else if (sort === ImageSort.MostComments) orderBy = `r."commentCount${period}Rank"`;
  else if (sort === ImageSort.MostReactions) orderBy = `r."reactionCount${period}Rank"`;

  if (needsReview) {
    AND.length = 0;
    AND.push(Prisma.sql`i."needsReview" = true`);
    orderBy = 'i.id';
  } else if (tagReview) {
    AND.length = 0;
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id AND toi."needsReview" = true
      )`);
    orderBy = 'i.id';
  }

  const [cursorProp, cursorDirection] = orderBy?.split(' ');
  if (cursor) {
    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    if (cursorProp)
      AND.push(Prisma.sql`${Prisma.raw(cursorProp)} ${Prisma.raw(cursorOperator)} ${cursor}`);
  }

  const rawImages = await dbRead.$queryRaw<GetGalleryImagesRaw[]>`
    SELECT
      i.id,
      i.name,
      i.url,
      i.nsfw,
      i.width,
      i.height,
      i.hash,
      i.meta,
      i."generationProcess",
      i."createdAt",
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."postId",
      i."createdAt",
      COALESCE(ior."index",iom."index",0) "index",
      m.id "modelId",
      ior."reviewId",
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      ${Prisma.raw(!user?.id ? 'null' : 'ir.reactions')} "reactions",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
    FROM "Image" i
    ${Prisma.raw(
      cursorProp?.startsWith('r.')
        ? `${optionalRank ? 'LEFT ' : ''}JOIN "ImageRank" r ON r."imageId" = i.id`
        : ''
    )}
    LEFT JOIN "ImagesOnModels" iom ON iom."imageId" = i.id
    LEFT JOIN "ModelVersion" mv ON mv.id = iom."modelVersionId"
    LEFT JOIN "ImagesOnReviews" ior ON ior."imageId" = i.id
    LEFT JOIN "Review" rev ON rev.id = ior."reviewId"
    JOIN "Model" m ON m.id = COALESCE(mv."modelId", rev."modelId") AND m.status = 'Published' AND m."tosViolation" = false
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'
    ${
      !user
        ? Prisma.sql``
        : Prisma.sql`LEFT JOIN (
        SELECT "imageId", jsonb_agg(reaction) "reactions"
        FROM "ImageReaction"
        WHERE "userId" = ${user.id}
        GROUP BY "imageId"
      ) ir ON ir."imageId" = i.id`
    }
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${limit}
  `;

  // Get Tags for images
  const imageIds = rawImages.map((i) => i.id);
  const rawTags = await dbRead.tagsOnImage.findMany({
    where: { disabled: false, imageId: { in: imageIds } },
    select: {
      imageId: true,
      automated: true,
      needsReview: true,
      tag: { select: { ...simpleTagSelect, type: true } },
    },
  });

  // Get Cosmetics for images
  const userIds = [...new Set(rawImages.map((i) => i.userId))];
  const rawUsers = await dbRead.user.findMany({
    where: { id: { in: userIds } },
    select: userWithCosmeticsSelect,
  });

  const images = rawImages.map(
    ({
      likeCount,
      dislikeCount,
      laughCount,
      cryCount,
      heartCount,
      commentCount,
      modelId,
      reviewId,
      index,
      reactions,
      ...i
    }) => ({
      ...i,
      metrics: { likeCount, dislikeCount, laughCount, cryCount, heartCount, commentCount },
      connections: index ? { modelId, reviewId, index: index as number | null } : null,
      reactions: userId ? reactions?.map((r) => ({ userId, reaction: r })) ?? [] : [],
      tags: rawTags.filter((t) => t.imageId === i.id).map(({ imageId, ...tag }) => tag),
      user: rawUsers.find((u) => u.id === i.userId) as UserWithCosmetics,
    })
  );
  return images;
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
  nsfw?: NsfwLevel;
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

    // Remove tags that triggered review
    const tagIds = await getTagsNeedingReview();
    await dbWrite.tagsOnImage.updateMany({
      where: { imageId: { in: ids }, tagId: { in: tagIds.map((x) => x.id) } },
      data: { disabled: true },
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
      data: { count: number };
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

  const callbackUrl = env.IMAGE_SCANNING_CALLBACK;
  const payload = {
    imageId: id,
    url: edgeUrl,
    wait: true,
    scans: [ImageScanType.Label, ImageScanType.Moderation],
    callbackUrl,
  };

  await dbWrite.image.update({
    where: { id },
    data: { scanRequestedAt: new Date() },
    select: { id: true },
  });

  if (!isProd && !callbackUrl) {
    // await dbWrite.tagsOnImage.create({
    //   data: {
    //     imageId: id,
    //     tagId: 7756,
    //     automated: true,
    //     confidence: 100,
    //   },
    // });
    console.log('skip ingest');
  } else {
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
  }

  const count = await dbWrite.tagsOnImage.count({ where: { imageId: id } });
  return {
    type: 'success',
    data: { count },
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
export function applyUserPreferencesSql(
  AND: Prisma.Sql[],
  {
    excludedUserIds,
    excludedImageIds,
    excludedTagIds,
    userId,
  }: UserPreferencesInput & { userId?: number }
) {
  // Exclude specific users
  if (excludedUserIds?.length)
    AND.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);

  // Exclude specific images
  if (excludedImageIds?.length)
    AND.push(Prisma.sql`i."id" NOT IN (${Prisma.join(excludedImageIds)})`);

  // Exclude specific tags
  if (excludedTagIds?.length) {
    const OR = [
      Prisma.join(
        [
          Prisma.sql`i."scannedAt" IS NOT NULL`,
          Prisma.sql`NOT EXISTS (
          SELECT 1 FROM "TagsOnImage" toi
          WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join([
            ...new Set(excludedTagIds),
          ])}) AND NOT toi.disabled
        )`,
        ],
        ' AND '
      ),
    ];
    if (userId) OR.push(Prisma.sql`i."userId" = ${userId}`);
    AND.push(Prisma.sql`(${Prisma.join(OR, ' OR ')})`);
  }

  return AND;
}

type GetAllImagesRaw = {
  id: number;
  name: string;
  url: string;
  nsfw: NsfwLevel;
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
  index: number;
  postId: number;
  modelVersionId: number | null;
  publishedAt: Date | null;
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
};
export type ImagesInfiniteModel = AsyncReturnType<typeof getAllImages>['items'][0];
export const getAllImages = async ({
  limit,
  cursor,
  skip,
  postId,
  modelId,
  modelVersionId,
  username,
  excludedTagIds,
  excludedUserIds,
  excludedImageIds,
  period,
  periodMode,
  sort,
  userId,
  isModerator,
  tags,
  generation,
  reviewId,
  prioritizedUserIds,
  needsReview,
  tagReview,
  include,
  nsfw,
  excludeCrossPosts,
}: GetInfiniteImagesInput & { userId?: number; isModerator?: boolean; nsfw?: NsfwLevel }) => {
  const AND = [Prisma.sql`i."postId" IS NOT NULL`];
  let orderBy: string;

  // If User Isn't mod
  if (!isModerator) {
    needsReview = false;
    tagReview = false;

    applyModRulesSql(AND, { userId });
  }

  if (needsReview) {
    AND.push(Prisma.sql`i."needsReview" = true`);
    AND.push(Prisma.sql`i."scannedAt" IS NOT NULL`);
    AND.push(Prisma.sql`p."publishedAt" IS NOT NULL`);
  }

  if (tagReview) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id AND toi."needsReview"
    )`);
  }

  if (excludeCrossPosts && modelVersionId) {
    AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);
  }

  // Filter to specific model/review content
  const prioritizeUser = !!prioritizedUserIds?.length;
  const optionalRank = !!(modelId || modelVersionId || reviewId || username);
  if (!prioritizeUser && (modelId || modelVersionId || reviewId)) {
    const irhAnd = [Prisma.sql`irr."imageId" = i.id`];
    if (modelVersionId) irhAnd.push(Prisma.sql`irr."modelVersionId" = ${modelVersionId}`);
    if (modelId) irhAnd.push(Prisma.sql`mv."modelId" = ${modelId}`);
    if (reviewId) irhAnd.push(Prisma.sql`re."id" = ${reviewId}`);
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ImageResource" irr
      ${Prisma.raw(modelId ? 'JOIN "ModelVersion" mv ON mv.id = irr."modelVersionId"' : '')}
      ${Prisma.raw(
        reviewId ? 'JOIN "ResourceReview" re ON re."modelVersionId" = irr."modelVersionId"' : ''
      )}
      WHERE ${Prisma.join(irhAnd, ' AND ')}
    )`);
  }

  // Filter to specific user content
  if (username) {
    const targetUser = await dbRead.user.findUnique({ where: { username }, select: { id: true } });
    if (!targetUser) throw new Error('User not found');
    AND.push(Prisma.sql`u."id" = ${targetUser.id}`);
  }

  // Filter to specific tags
  if (tags?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(tags)}) AND NOT toi.disabled
    )`);
  }

  // Filter to specific generation process
  if (generation?.length) {
    AND.push(Prisma.sql`i."generationProcess" IN (${Prisma.join(generation)})`);
  }

  // Filter to a specific post
  if (postId) AND.push(Prisma.sql`i."postId" = ${postId}`);

  if (postId && !modelId) {
    // a post image query won't include modelId
    orderBy = `i."index"`;
  } else {
    // Sort by selected sort
    if (sort === ImageSort.MostComments) orderBy = `r."commentCount${period}Rank"`;
    else if (sort === ImageSort.MostReactions) orderBy = `r."reactionCount${period}Rank"`;
    else orderBy = `i."id" DESC`;
  }

  // Apply user preferences
  applyUserPreferencesSql(AND, {
    excludedImageIds,
    excludedTagIds,
    excludedUserIds,
    userId,
  });

  if (nsfw === NsfwLevel.None) AND.push(Prisma.sql`i."nsfw" = 'None'`);
  else if (nsfw !== undefined) {
    const nsfwLevels = nsfwLevelOrder.slice(1, nsfwLevelOrder.indexOf(nsfw) + 1);
    AND.push(Prisma.sql`i."nsfw" = ANY(ARRAY[${Prisma.join(nsfwLevels)}]::"NsfwLevel"[])`);
  }

  // Limit to images created since period start
  if (period !== 'AllTime' && periodMode !== 'stats')
    AND.push(Prisma.raw(`i."createdAt" >= now() - INTERVAL '1 ${period}'`));

  const [cursorProp, cursorDirection] = orderBy?.split(' ');
  if (cursor) {
    if (skip) throw new Error('Cannot use skip with cursor');

    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    if (cursorProp)
      AND.push(Prisma.sql`${Prisma.raw(cursorProp)} ${Prisma.raw(cursorOperator)} ${cursor}`);
  }

  if (prioritizeUser) {
    if (cursor) throw new Error('Cannot use cursor with prioritizedUserIds');
    if (modelVersionId) AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);

    // If system user, show community images
    if (prioritizedUserIds.length === 1 && prioritizedUserIds[0] === -1)
      orderBy = `IIF(i."userId" IN (${prioritizedUserIds.join(',')}), i.index, 1000),  ${orderBy}`;
    else {
      // For everyone else, only show their images.
      AND.push(Prisma.sql`i."userId" IN (${Prisma.join(prioritizedUserIds)})`);
      orderBy = `i."postId" + i."index"`; // Order by oldest post first
    }
  }

  const includeRank = cursorProp?.startsWith('r.');

  const queryFrom = Prisma.sql`
    FROM "Image" i
    JOIN "User" u ON u.id = i."userId"
    JOIN "Post" p ON p.id = i."postId"
    ${Prisma.raw(
      includeRank ? `${optionalRank ? 'LEFT ' : ''}JOIN "ImageRank" r ON r."imageId" = i.id` : ''
    )}
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'::"MetricTimeframe"
    ${
      !userId
        ? Prisma.sql``
        : Prisma.sql`LEFT JOIN (
      SELECT "imageId", jsonb_agg(reaction) "reactions"
      FROM "ImageReaction"
      WHERE "userId" = ${userId}
      GROUP BY "imageId"
    ) ir ON ir."imageId" = i.id`
    }
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  const rawImages = await dbRead.$queryRaw<GetAllImagesRaw[]>`
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
      i."postId",
      i."index",
      p."publishedAt",
      p."modelVersionId",
      u.username,
      u.image "userImage",
      u."deletedAt",
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      ${Prisma.raw(!userId ? 'null' : 'ir.reactions')} "reactions",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
      ${queryFrom}
      ORDER BY ${Prisma.raw(orderBy)} ${Prisma.raw(includeRank && optionalRank ? 'NULLS LAST' : '')}
      ${Prisma.raw(skip ? `OFFSET ${skip}` : '')}
      LIMIT ${limit + 1}
  `;

  let nextCursor: bigint | undefined;
  if (rawImages.length > limit) {
    const nextItem = rawImages.pop();
    nextCursor = nextItem?.cursorId;
  }

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined;
  if (include?.includes('tags')) {
    const imageIds = rawImages.map((i) => i.id);
    const rawTags = await dbRead.imageTag.findMany({
      where: { imageId: { in: imageIds } },
      select: {
        imageId: true,
        tagId: true,
        tagName: true,
        tagType: true,
        tagNsfw: true,
        score: true,
        automated: true,
        upVotes: true,
        downVotes: true,
        needsReview: true,
      },
    });

    tagsVar = rawTags.map(({ tagId, tagName, tagType, tagNsfw, ...tag }) => ({
      ...tag,
      id: tagId,
      type: tagType,
      nsfw: tagNsfw,
      name: tagName,
    }));

    if (userId) {
      const userVotes = await dbRead.tagsOnImageVote.findMany({
        where: { imageId: { in: imageIds }, userId },
        select: { imageId: true, tagId: true, vote: true },
      });

      for (const tag of tagsVar) {
        const userVote = userVotes.find(
          (vote) => vote.tagId === tag.id && vote.imageId === tag.imageId
        );
        if (userVote) tag.vote = userVote.vote > 0 ? 1 : -1;
      }
    }
  }

  // Get user cosmetics
  const includeCosmetics = include?.includes('cosmetics');
  let userCosmetics:
    | Record<
        number,
        {
          type: CosmeticType;
          id: number;
          data: Prisma.JsonValue;
          source: CosmeticSource;
          name: string;
        }[]
      >
    | undefined;
  if (includeCosmetics) {
    const users = [...new Set(rawImages.map((i) => i.userId))];
    const userCosmeticsRaw = await dbRead.userCosmetic.findMany({
      where: { userId: { in: users }, equippedAt: { not: null } },
      select: {
        userId: true,
        cosmetic: { select: { id: true, data: true, type: true, source: true, name: true } },
      },
    });
    userCosmetics = userCosmeticsRaw.reduce((acc, { userId, cosmetic }) => {
      acc[userId] = acc[userId] ?? [];
      acc[userId].push(cosmetic);
      return acc;
    }, {} as Record<number, (typeof userCosmeticsRaw)[0]['cosmetic'][]>);
  }

  const images: Array<
    ImageV2Model & {
      tags: VotableTagModel[] | undefined;
      publishedAt: Date | null;
      modelVersionId: number | null;
    }
  > = rawImages.map(
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
        cosmetics: userCosmetics?.[creatorId]?.map((cosmetic) => ({ cosmetic })) ?? [],
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
      tags: tagsVar?.filter((x) => x.imageId === i.id),
    })
  );

  let count: number | undefined;
  if (include?.includes('count')) {
    const whereHash = hashify(queryFrom.text + queryFrom.values);
    const countCache = await redis.get(`system:image-count:${whereHash}`);
    if (countCache) count = Number(countCache);
    else {
      const [countResult] = await dbRead.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*) "count"
        ${queryFrom}
      `;
      count = Number(countResult.count);
      await redis.set(`system:image-count:${whereHash}`, count, {
        EX: 60 * 5,
      });
    }
  }

  return {
    nextCursor,
    count,
    items: images,
  };
};

export const getImage = async ({
  id,
  userId,
  isModerator,
}: GetImageInput & { userId?: number; isModerator?: boolean }) => {
  const image = await dbRead.image.findFirst({
    where: { id, OR: isModerator ? undefined : [{ needsReview: false }, { userId }] },
    select: getImageV2Select({ userId }),
  });
  if (!image) throw throwAuthorizationError();
  return image;
};

export const getImageResources = async ({ id }: GetByIdInput) => {
  return await dbRead.imageResourceHelper.findMany({
    where: { imageId: id, OR: [{ hash: { not: null } }, { modelVersionId: { not: null } }] },
    select: {
      id: true,
      reviewId: true,
      reviewRating: true,
      reviewDetails: true,
      reviewCreatedAt: true,
      name: true,
      hash: true,
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

type ImagesForModelVersions = {
  id: number;
  userId: number;
  name: string;
  url: string;
  nsfw: NsfwLevel;
  width: number;
  height: number;
  hash: string;
  modelVersionId: number;
  meta?: Prisma.JsonValue;
};
export const getImagesForModelVersion = async ({
  modelVersionIds,
  excludedTagIds,
  excludedIds,
  excludedUserIds,
  currentUserId,
  imagesPerVersion = 1,
  include = [],
}: {
  modelVersionIds: number | number[];
  excludedTagIds?: number[];
  excludedIds?: number[];
  excludedUserIds?: number[];
  currentUserId?: number;
  imagesPerVersion?: number;
  include?: Array<'meta'>;
}) => {
  if (!Array.isArray(modelVersionIds)) modelVersionIds = [modelVersionIds];
  if (!modelVersionIds.length) return [] as ImagesForModelVersions[];

  const imageWhere: Prisma.Sql[] = [
    Prisma.sql`p."modelVersionId" IN (${Prisma.join(modelVersionIds)})`,
    Prisma.sql`i."needsReview" = false`,
  ];
  if (!!excludedTagIds?.length) {
    const excludedTagsOr: Prisma.Sql[] = [
      Prisma.join(
        [
          Prisma.sql`i."scannedAt" IS NOT NULL`,
          Prisma.sql`NOT EXISTS (SELECT 1 FROM "TagsOnImage" toi WHERE toi."imageId" = i.id AND toi.disabled = false AND toi."tagId" IN (${Prisma.join(
            excludedTagIds
          )}) )`,
        ],
        ' AND '
      ),
    ];
    if (currentUserId) excludedTagsOr.push(Prisma.sql`i."userId" = ${currentUserId}`);
    imageWhere.push(Prisma.sql`(${Prisma.join(excludedTagsOr, ' OR ')})`);
  }
  if (!!excludedIds?.length) {
    imageWhere.push(Prisma.sql`i.id NOT IN (${Prisma.join(excludedIds)})`);
  }
  if (!!excludedUserIds?.length) {
    imageWhere.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
  }
  const images = await dbRead.$queryRaw<ImagesForModelVersions[]>`
    WITH targets AS (
      SELECT
        id,
        "modelVersionId"
      FROM (
        SELECT
          i.id,
          p."modelVersionId",
          row_number() OVER (PARTITION BY p."modelVersionId" ORDER BY i."postId", i.index) row_num
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId" AND m."userId" = p."userId"
        WHERE ${Prisma.join(imageWhere, ' AND ')}
      ) ranked
      WHERE ranked.row_num <= ${imagesPerVersion}
    )
    SELECT
      i.id,
      i."userId",
      i.name,
      i.url,
      i.nsfw,
      i.width,
      i.height,
      i.hash,
      t."modelVersionId"
      ${Prisma.raw(include.includes('meta') ? ', i.meta' : '')}
    FROM targets t
    JOIN "Image" i ON i.id = t.id
    ORDER BY i."index"
  `;

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
      userId: number;
      name: string;
      url: string;
      nsfw: NsfwLevel;
      width: number;
      height: number;
      hash: string;
      postId: number;
      imageCount: number;
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
        MIN(i.index) "index",
        COUNT(*) "count"
      FROM "Image" i
      WHERE ${imageWhere.join(' AND ')}
      GROUP BY i."postId"
    )
    SELECT
      i.id,
      i."userId",
      i.name,
      i.url,
      i.nsfw,
      i.width,
      i.height,
      i.hash,
      t."postId",
      t.count "imageCount",
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
    reactions: userId ? reactions?.map((r) => ({ userId, reaction: r })) ?? [] : [],
  }));
};

// type ImageTagResult = { id: number; name: string; isCategory: boolean; postCount: number }[];
// export const getPostTags = async ({
//   query,
//   limit,
//   excludedTagIds,
// }: GetPostTagsInput & { excludedTagIds?: number[] }) => {
//   const showTrending = query === undefined || query.length < 2;
//   const tags = await dbRead.$queryRaw<PostQueryResult>`
//     SELECT
//       t.id,
//       t.name,
//       t."isCategory",
//       COALESCE(${
//         showTrending ? Prisma.sql`s."postCountDay"` : Prisma.sql`s."postCountAllTime"`
//       }, 0)::int AS "postCount"
//     FROM "Tag" t
//     LEFT JOIN "TagStat" s ON s."tagId" = t.id
//     LEFT JOIN "TagRank" r ON r."tagId" = t.id
//     WHERE
//       ${showTrending ? Prisma.sql`t."isCategory" = true` : Prisma.sql`t.name ILIKE ${query + '%'}`}
//     ORDER BY ${Prisma.raw(
//       showTrending ? `r."postCountDayRank" DESC` : `LENGTH(t.name), r."postCountAllTimeRank" DESC`
//     )}
//     LIMIT ${limit}
//   `;

//   return (
//     !!excludedTagIds?.length ? tags.filter((x) => !excludedTagIds.includes(x.id)) : tags
//   ).sort((a, b) => b.postCount - a.postCount);
// };
// #endregion

export const removeImageResource = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  if (!user?.isModerator) throw throwAuthorizationError();

  try {
    const resource = await dbWrite.imageResource.delete({
      where: { id },
    });
    if (!resource) throw throwNotFoundError(`No image resource with id ${id}`);

    return resource;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export function applyModRulesSql(AND: Prisma.Sql[], { userId }: { userId?: number }) {
  // Hide images that need review
  const needsReviewOr = [Prisma.sql`i."needsReview" = false`];
  // Hide images that aren't published
  const publishedOr = [Prisma.sql`p."publishedAt" IS NOT NULL`];

  if (userId) {
    const belongsToUser = Prisma.sql`i."userId" = ${userId}`;
    needsReviewOr.push(belongsToUser);
    publishedOr.push(belongsToUser);
  }
  AND.push(Prisma.sql`(${Prisma.join(needsReviewOr, ' OR ')})`);
  AND.push(Prisma.sql`(${Prisma.join(publishedOr, ' OR ')})`);
}

type GetImageByCategoryRaw = {
  id: number;
  tagId: number;
  name: string;
  url: string;
  nsfw: NsfwLevel;
  width: number;
  height: number;
  hash: string;
  meta: Prisma.JsonValue;
  hideMeta: boolean;
  generationProcess: ImageGenerationProcess;
  mimeType: string;
  scannedAt: Date;
  needsReview: boolean;
  postId: number;
  username: string | null;
  userImage: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  cryCount: number;
  laughCount: number;
  likeCount: number;
  dislikeCount: number;
  heartCount: number;
  commentCount: number;
};
export const getImagesByCategory = async ({
  userId,
  ...input
}: GetImagesByCategoryInput & { userId?: number }) => {
  input.limit ??= 10;

  let categories = await getTypeCategories({
    type: 'image',
    excludeIds: input.excludedTagIds,
    limit: input.limit + 1,
    cursor: input.cursor,
  });

  let nextCursor: number | null = null;
  if (categories.length > input.limit) nextCursor = categories.pop()?.id ?? null;
  categories = shuffle(categories);

  const AND = [Prisma.sql`p."publishedAt" IS NOT NULL`];

  // Apply excluded tags
  if (input.excludedTagIds?.length)
    AND.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id
      AND toi."tagId" IN (${Prisma.join(input.excludedTagIds)})
    )`);

  // Apply excluded users
  if (input.excludedUserIds?.length)
    AND.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(input.excludedUserIds)})`);

  // Limit to selected user
  if (input.username) {
    const targetUser = await dbRead.user.findUnique({
      where: { username: input.username },
      select: { id: true },
    });
    if (!targetUser) throw new Error('User not found');
    AND.push(Prisma.sql`i."userId" = ${targetUser.id}`);
  }

  // Limit to selected model/version
  if (input.modelId) AND.push(Prisma.sql`mv."modelId" = ${input.modelId}`);
  if (input.modelVersionId) AND.push(Prisma.sql`ir."modelVersionId" = ${input.modelVersionId}`);

  // Apply mod rules
  applyModRulesSql(AND, { userId });

  let orderBy = `p."publishedAt" DESC, i.index`;
  if (input.sort === ImageSort.MostReactions)
    orderBy = `im."likeCount"+im."heartCount"+im."laughCount"+im."cryCount" DESC NULLS LAST, ${orderBy}`;
  else if (input.sort === ImageSort.MostComments)
    orderBy = `im."commentCount" DESC NULLS LAST, ${orderBy}`;

  const targets = categories.map((c) => {
    return Prisma.sql`(
      SELECT
        toi."imageId",
        "tagId",
        row_number() OVER (ORDER BY ${Prisma.raw(orderBy)}) "index"
      FROM "TagsOnImage" toi
      JOIN "Image" i ON i.id = toi."imageId"
      JOIN "Post" p ON p.id = i."postId"
        ${Prisma.raw(
          input.period !== 'AllTime' && input.periodMode !== 'stats'
            ? `AND p."publishedAt" > now() - INTERVAL '1 ${input.period}'`
            : 'AND p."publishedAt" IS NOT NULL'
        )}
      ${Prisma.raw(
        input.modelId || input.modelVersionId
          ? `JOIN "ImageResource" ir ON ir."imageId" = toi."imageId" AND ir."modelVersionId" IS NOT NULL`
          : ''
      )}
      ${Prisma.raw(input.modelId ? `JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"` : '')}
      ${Prisma.raw(
        orderBy.startsWith('im')
          ? `LEFT JOIN "ImageMetric" im ON im."imageId" = toi."imageId" AND im.timeframe = '${input.period}'`
          : ''
      )}
      WHERE toi."tagId" = ${c.id}
      AND ${Prisma.join(AND, ' AND ')}
      ORDER BY ${Prisma.raw(orderBy)}
      LIMIT ${Math.ceil((input.imageLimit ?? 12) * 1.25)}
    )`;
  });

  let imagesRaw: GetImageByCategoryRaw[] = [];
  const cacheKey = `trpc:image:imagesByCategory:${hashifyObject(input)}`;
  const cache = await redis.get(cacheKey);
  if (cache) imagesRaw = JSON.parse(cache);
  else {
    imagesRaw = await dbRead.$queryRaw<GetImageByCategoryRaw[]>`
      WITH targets AS (
        ${Prisma.join(targets, ' UNION ALL ')}
      )
      SELECT
        i.id,
        t."tagId",
        i.name,
        i.url,
        i.nsfw,
        i.width,
        i.height,
        i.hash,
        i.meta,
        i."hideMeta",
        i."generationProcess",
        i."mimeType",
        i."scannedAt",
        i."needsReview",
        i."postId",
        u.username,
        u.image AS "userImage",
        i."createdAt",
        p."publishedAt",
        COALESCE(im."cryCount", 0) "cryCount",
        COALESCE(im."laughCount", 0) "laughCount",
        COALESCE(im."likeCount", 0) "likeCount",
        COALESCE(im."dislikeCount", 0) "dislikeCount",
        COALESCE(im."heartCount", 0) "heartCount",
        COALESCE(im."commentCount", 0) "commentCount"
      FROM targets t
      JOIN "Image" i ON i.id = t."imageId"
      JOIN "Post" p ON p.id = i."postId"
      JOIN "User" u ON u.id = p."userId"
      LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im."timeframe" = 'AllTime'::"MetricTimeframe"
      ORDER BY t."index"
    `;
    await redis.set(cacheKey, JSON.stringify(imagesRaw), { EX: 60 * 3 });
  }

  const reactions = userId
    ? await dbRead.imageReaction.findMany({
        where: { userId, imageId: { in: imagesRaw.map((x) => x.id) } },
        select: { imageId: true, reaction: true },
      })
    : [];

  // Map category record to array
  const items = categories.map((c) => {
    const items = imagesRaw
      .filter((x) => x.tagId === c.id)
      .map((x) => ({
        ...x,
        reactions: userId ? reactions.map((r) => ({ userId, reaction: r.reaction })) : [],
      }));
    return { ...c, items };
  });

  return { items, nextCursor };
};
