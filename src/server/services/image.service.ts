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
import { VotableTagModel } from '~/libs/tags';
import { UserWithCosmetics, userWithCosmeticsSelect } from '~/server/selectors/user.selector';

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
  nsfw: boolean;
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

  // Filter to specific tags
  if (tags?.length) {
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
  if (reviewId) AND.push(Prisma.sql`ic."reviewId" = ${reviewId}`);
  else if (modelVersionId) {
    AND.push(Prisma.sql`ic."modelVersionId" = ${modelVersionId}`);
    if (!infinite) AND.push(Prisma.sql`ic."reviewId" IS NULL`);
  } else if (modelId) AND.push(Prisma.sql`ic."modelId" = ${modelId}`);
  AND.push(Prisma.sql`(rev.id IS NULL OR rev."tosViolation" = false)`);

  let orderBy = 'i.id DESC';
  if (!infinite) orderBy = 'ic."index"';
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

  console.time('getGalleryImages');
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
      ic."index",
      ic."modelId",
      ic."reviewId",
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      ${Prisma.raw(!user?.id ? 'null' : 'ir.reactions')} "reactions",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
    FROM "Image" i
    ${Prisma.raw(cursorProp?.startsWith('r.') ? 'JOIN "ImageRank" r ON r."imageId" = i.id' : '')}
    JOIN "ImageConnection" ic ON ic."imageId" = i.id
    JOIN "Model" m ON m.id = ic."modelId" AND m.status = 'Published' AND m."tosViolation" = false
    LEFT JOIN "Review" rev ON ic."reviewId" IS NOT NULL AND rev.id = ic."reviewId"
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'
    ${Prisma.raw(
      !user
        ? ''
        : `LEFT JOIN (
        SELECT "imageId", jsonb_agg(reaction) "reactions"
        FROM "ImageReaction"
        WHERE "userId" = ${user.id}
        GROUP BY "imageId"
      ) ir ON ir."imageId" = i.id`
    )}
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
  console.timeEnd('getGalleryImages');
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
  return await dbWrite.image.findFirst({
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
  if (!isProd) return { type: 'success', data: { tags: [] } };
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
type GetAllImagesRaw = {
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
  postId: number;
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
  postId,
  modelId,
  modelVersionId,
  username,
  excludedTagIds,
  excludedUserIds,
  excludedImageIds,
  period,
  sort,
  userId,
  isModerator,
  tags,
  generation,
  reviewId,
  withTags, // TODO.justin - return image tags when this is requested
  prioritizedUserIds,
}: GetInfiniteImagesInput & { userId?: number; isModerator?: boolean }) => {
  const AND = [Prisma.sql`i."postId" IS NOT NULL`];
  let orderBy: string;

  // If User Is Mod
  if (!isModerator) AND.push(Prisma.sql`i."needsReview" = false`);

  // Filter to specific model/review content
  if (modelId || modelVersionId || reviewId) {
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
      WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(tags)})
    )`);
  }

  // Filter to specific generation process
  if (generation?.length) {
    AND.push(Prisma.sql`i."generationProcess" IN (${Prisma.join(generation)})`);
  }

  // Filter to a specific post
  if (postId) {
    AND.push(Prisma.sql`i."postId" = ${postId}`);
    orderBy = `i."index"`;
  } else {
    // Sort by selected sort
    if (sort === ImageSort.MostComments) orderBy = `r."commentCount${period}Rank"`;
    else if (sort === ImageSort.MostReactions) orderBy = `r."reactionCount${period}Rank"`;
    else orderBy = `i."id" DESC`;
  }

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
          WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(excludedTagIds)})
        )`,
        ],
        ' AND '
      ),
    ];
    if (userId) OR.push(Prisma.sql`i."userId" = ${userId}`);
    AND.push(Prisma.sql`(${Prisma.join(OR, ' OR ')})`);
  }

  const [cursorProp, cursorDirection] = orderBy?.split(' ');
  if (cursor) {
    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    if (cursorProp)
      AND.push(Prisma.sql`${Prisma.raw(cursorProp)} ${Prisma.raw(cursorOperator)} ${cursor}`);
  }

  if (!!prioritizedUserIds?.length) {
    if (cursor) throw new Error('Cannot use cursor with prioritizedUserIds');
    orderBy = `IIF(i."userId" IN (${Prisma.join(prioritizedUserIds)}),0,1), ${orderBy}`;
  }

  console.log('getAllImages start');
  console.time('getAllImages');
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
    FROM "Image" i
    JOIN "User" u ON u.id = i."userId"
    ${Prisma.raw(cursorProp?.startsWith('r.') ? 'JOIN "ImageRank" r ON r."imageId" = i.id' : '')}
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = ${period}::"MetricTimeframe"
    ${Prisma.raw(
      !userId
        ? ''
        : `LEFT JOIN (
      SELECT "imageId", jsonb_agg(reaction) "reactions"
      FROM "ImageReaction"
      WHERE "userId" = ${userId}
      GROUP BY "imageId"
    ) ir ON ir."imageId" = i.id`
    )}
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${limit + 1}
  `;
  console.timeLog('getAllImages');

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined;
  if (withTags) {
    const imageIds = rawImages.map((i) => i.id);
    const rawTags = await dbRead.imageTag.findMany({
      where: { imageId: { in: imageIds } },
      select: {
        imageId: true,
        tagId: true,
        tagName: true,
        tagType: true,
        score: true,
        automated: true,
        upVotes: true,
        downVotes: true,
      },
    });
    console.timeLog('getAllImages');

    tagsVar = rawTags.map(({ tagId, tagName, tagType, ...tag }) => ({
      ...tag,
      id: tagId,
      type: tagType,
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
      console.timeLog('getAllImages');
    }
  }

  const images: Array<ImageV2Model & { tags: VotableTagModel[] | undefined }> = rawImages.map(
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
      tags: tagsVar?.filter((x) => x.imageId === i.id),
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

type ImagesForModelVersions = {
  id: number;
  userId: number;
  name: string;
  url: string;
  nsfw: boolean;
  width: number;
  height: number;
  hash: string;
  modelVersionId: number;
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
  const imageWhere: Prisma.Sql[] = [
    Prisma.sql`iom."modelVersionId" IN (${Prisma.join(modelVersionIds)})`,
    Prisma.sql`i."needsReview" = false`,
  ];
  if (!!excludedTagIds?.length) {
    imageWhere.push(Prisma.sql`i."scannedAt" IS NOT NULL`);
    imageWhere.push(
      Prisma.sql`NOT EXISTS (SELECT 1 FROM "TagsOnImage" toi WHERE toi."imageId" = iom."imageId" AND toi.disabled = false AND toi."tagId" IN (${Prisma.join(
        excludedTagIds
      )}) )`
    );
  }
  if (!!excludedIds?.length) {
    imageWhere.push(Prisma.sql`iom."imageId" NOT IN (${Prisma.join(excludedIds)})`);
  }
  if (!!excludedUserIds?.length) {
    imageWhere.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
  }
  console.time('getImagesForModelVersion');
  const images = await dbRead.$queryRaw<ImagesForModelVersions[]>`
    WITH targets AS (
      SELECT
        iom."modelVersionId",
        MIN(iom.index) "index"
      FROM "ImagesOnModels" iom
      JOIN "Image" i ON i.id = iom."imageId"
      WHERE ${Prisma.join(imageWhere, ' AND ')}
      GROUP BY iom."modelVersionId"
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
    FROM targets t
    JOIN "ImagesOnModels" iom ON iom.index = t.index AND iom."modelVersionId" = t."modelVersionId"
    JOIN "Image" i ON i.id = iom."imageId";
  `;
  console.timeEnd('getImagesForModelVersion');

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
      i."userId",
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
    reactions: userId ? reactions?.map((r) => ({ userId, reaction: r })) ?? [] : [],
  }));
};
// #endregion
