import {
  CosmeticSource,
  CosmeticType,
  ImageGenerationProcess,
  ImageIngestionStatus,
  MediaType,
  NsfwLevel,
  Prisma,
  ReportReason,
  ReportStatus,
  ReviewReactions,
  SearchIndexUpdateQueueAction,
} from '@prisma/client';
import { SessionUser } from 'next-auth';
import { isProd } from '~/env/other';
import {
  GetImageInput,
  GetImagesByCategoryInput,
  GetInfiniteImagesInput,
  ImageMetaProps,
  ImageModerationSchema,
  IngestImageInput,
  ingestImageSchema,
  isImageResource,
} from './../schema/image.schema';

import { TRPCError } from '@trpc/server';
import { env } from '~/env/server.mjs';
import { nsfwLevelOrder } from '~/libs/moderation';
import { VotableTagModel } from '~/libs/tags';
import { ImageScanType, ImageSort } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { UserPreferencesInput } from '~/server/schema/base.schema';
import { redis } from '~/server/redis/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { UpdateImageInput } from '~/server/schema/image.schema';
import { ImageV2Model } from '~/server/selectors/imagev2.selector';
import { imageTagCompositeSelect, simpleTagSelect } from '~/server/selectors/tag.selector';
import { UserWithCosmetics, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getAllowedAnonymousTags, getTagsNeedingReview } from '~/server/services/system-cache';
import { getTypeCategories } from '~/server/services/tag.service';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { decreaseDate } from '~/utils/date-helpers';
import { deleteObject } from '~/utils/s3-utils';
import { hashifyObject } from '~/utils/string-helpers';
import { logToDb } from '~/utils/logging';
import { imagesSearchIndex } from '~/server/search-index';
import { getCosmeticsForUsers } from '~/server/services/user.service';
// TODO.ingestion - logToDb something something 'axiom'

// no user should have to see images on the site that haven't been scanned or are queued for removal

export const imageUrlInUse = async ({ url, id }: { url: string; id: number }) => {
  const otherImagesWithSameUrl = await dbWrite.image.count({
    where: {
      url: url,
      id: { not: id },
    },
  });

  return otherImagesWithSameUrl > 0;
};

export const deleteImageById = async ({ id }: GetByIdInput) => {
  try {
    const image = await dbRead.image.findUnique({ where: { id }, select: { url: true } });
    if (isProd && image && !imageUrlInUse({ url: image.url, id }))
      await deleteObject(env.S3_IMAGE_UPLOAD_BUCKET, image.url); // Remove from storage

    if (image) {
      await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
    }

    return await dbWrite.image.delete({ where: { id } });
  } catch {
    // Ignore errors
  }
};

// consider refactoring this endoint to only allow for updating `needsReview`, because that is all this endpoint is being used for...
export const updateImageById = async <TSelect extends Prisma.ImageSelect>({
  id,
  select,
  data,
}: {
  id: number;
  data: Prisma.ImageUpdateArgs['data'];
  select: TSelect;
}) => {
  const image = await dbWrite.image.update({ where: { id }, data, select });

  if (image.tosViolation) {
    await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
  }

  return image;
};

export const moderateImages = async ({
  ids,
  nsfw,
  needsReview,
  delete: deleteImages,
  reviewType,
}: ImageModerationSchema) => {
  if (deleteImages) {
    if (reviewType !== 'reported') {
      await dbWrite.image.updateMany({
        where: { id: { in: ids }, needsReview: { not: null } },
        data: { nsfw, needsReview: null, ingestion: 'Blocked' },
      });
    } else {
      await dbWrite.image.deleteMany({ where: { id: { in: ids } } });
    }

    await imagesSearchIndex.queueUpdate(
      ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Delete }))
    );
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

export const ingestImage = async ({ image }: { image: IngestImageInput }): Promise<boolean> => {
  if (!env.IMAGE_SCANNING_ENDPOINT)
    throw new Error('missing IMAGE_SCANNING_ENDPOINT environment variable');
  const { url, id } = ingestImageSchema.parse(image);

  const callbackUrl = env.IMAGE_SCANNING_CALLBACK;
  const scanRequestedAt = new Date();

  if (!isProd && !callbackUrl) {
    console.log('skip ingest');
    return true;
  }
  const response = await fetch(env.IMAGE_SCANNING_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageId: id,
      imageKey: url,
      // wait: true,
      scans: [ImageScanType.Label, ImageScanType.Moderation],
      callbackUrl,
    }),
  });
  if (response.status === 202) {
    await dbWrite.image.updateMany({
      where: { id },
      data: { scanRequestedAt },
    });
    return true;
  } else {
    await logToDb('image-ingestion', {
      type: 'error',
      imageId: id,
      url,
    });
    return false;
  }
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
  meta: ImageMetaProps;
  hideMeta: boolean;
  generationProcess: ImageGenerationProcess;
  createdAt: Date;
  mimeType: string;
  scannedAt: Date;
  needsReview: string | null;
  userId: number;
  index: number;
  postId: number;
  postTitle: string;
  modelVersionId: number | null;
  imageId: number | null;
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
  type: MediaType;
  metadata: Prisma.JsonValue;
};
export type ImagesInfiniteModel = AsyncReturnType<typeof getAllImages>['items'][0];
export const getAllImages = async ({
  limit,
  cursor,
  skip,
  postId,
  collectionId,
  modelId,
  modelVersionId,
  imageId,
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
  reportReview,
  include,
  nsfw,
  excludeCrossPosts,
  reactions,
  ids,
  headers,
}: GetInfiniteImagesInput & {
  userId?: number;
  isModerator?: boolean;
  nsfw?: NsfwLevel;
  headers?: Record<string, string>;
}) => {
  const AND = [Prisma.sql`i."postId" IS NOT NULL`];
  let orderBy: string;

  // ensure that only scanned images make it to the main feed if no user is logged in
  if (!userId)
    AND.push(Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`);
  // otherwise, bring scanned images or all images created by the current user
  else
    AND.push(
      Prisma.sql`(i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus" OR i."userId" = ${userId})`
    );

  // If User Isn't mod
  if (!isModerator) {
    needsReview = null;
    tagReview = false;
    reportReview = false;

    applyModRulesSql(AND, { userId, publishedOnly: !collectionId });
  }

  if (needsReview) {
    AND.push(Prisma.sql`i."needsReview" = ${needsReview}`);
    AND.push(Prisma.sql`i."scannedAt" IS NOT NULL`);
    AND.push(Prisma.sql`p."publishedAt" IS NOT NULL`);
  }

  if (tagReview) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id AND toi."needsReview"
    )`);
  }

  if (reportReview) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ImageReport" imgr
      JOIN "Report" report ON report.id = imgr."reportId"
      WHERE imgr."imageId" = i.id AND report."status" = 'Pending'
    )`);
  }

  if (excludeCrossPosts && modelVersionId) {
    AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);
  }

  if (ids && ids.length > 0) {
    AND.push(Prisma.sql`i."id" IN (${Prisma.join(ids)})`);
  }

  // Filter to specific model/review content
  const prioritizeUser = !!prioritizedUserIds?.length;
  const optionalRank = !!(modelId || modelVersionId || reviewId || username || collectionId);
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

  // Filter to a specific image
  if (imageId) AND.push(Prisma.sql`i.id = ${imageId}`);

  // Filter to a specific collection and relevant status:
  if (collectionId) {
    const displayReviewItems = userId
      ? `OR (ci."status" = 'REVIEW' AND ci."addedById" = ${userId})`
      : '';

    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      WHERE ci."collectionId" = ${collectionId}
        AND ci."imageId" = i.id
        AND (ci."status" = 'ACCEPTED' ${Prisma.raw(displayReviewItems)})
    )`);
  }

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
      orderBy = `(i."postId" * 100) + i."index"`; // Order by oldest post first
    }
  }

  if (userId && !!reactions?.length) {
    AND.push(
      Prisma.sql`EXISTS (
        SELECT 1
        FROM "ImageReaction" ir
        WHERE ir."imageId" = i.id
          AND ir.reaction::text IN (${Prisma.join(reactions)})
          AND ir."userId" = ${userId}
      )`
    );
  }

  const includeRank = cursorProp?.startsWith('r.');

  // TODO: Adjust ImageMetric
  const queryFrom = Prisma.sql`
    FROM "Image" i
    JOIN "User" u ON u.id = i."userId"
    JOIN "Post" p ON p.id = i."postId" ${Prisma.raw(
      !isModerator
        ? `AND (p."publishedAt" < now() ${userId ? `OR p."userId" = ${userId}` : ''})`
        : ''
    )}
    ${Prisma.raw(
      includeRank ? `${optionalRank ? 'LEFT ' : ''}JOIN "ImageRank" r ON r."imageId" = i.id` : ''
    )}
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'::"MetricTimeframe"
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  const exclusions =
    (excludedImageIds?.length ?? 0) +
    (excludedTagIds?.length ?? 0) +
    (excludedUserIds?.length ?? 0);
  const queryHeader = Object.entries({
    exclusions,
    cursor,
    skip,
    limit,
    ...(headers ?? {}),
  })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  const rawImages = await dbRead.$queryRaw<GetAllImagesRaw[]>`
    -- ${Prisma.raw(queryHeader)}
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
      i.type,
      i.metadata,
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."postId",
      p."title" "postTitle",
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
      (
        SELECT jsonb_agg(reaction)
        FROM "ImageReaction"
        WHERE "imageId" = i.id
        AND "userId" = ${userId}
      ) reactions,
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
  const userCosmetics = include?.includes('cosmetics')
    ? await getCosmeticsForUsers(rawImages.map((i) => i.userId))
    : undefined;

  let reportVar: Array<{
    id: number;
    reason: string;
    details: Prisma.JsonValue;
    status: ReportStatus;
    user: { id: number; username: string | null };
    imageId: number;
  }>;
  if (include?.includes('report')) {
    const imageIds = rawImages.map((i) => i.id);
    const rawReports = await dbRead.imageReport.findMany({
      where: { imageId: { in: imageIds }, report: { status: 'Pending' } },
      select: {
        imageId: true,
        report: {
          select: {
            id: true,
            reason: true,
            status: true,
            details: true,
            user: { select: { id: true, username: true } },
          },
        },
      },
    });

    reportVar = rawReports.map(({ imageId, report }) => ({
      imageId,
      ...report,
    }));
  }

  const images: Array<
    ImageV2Model & {
      tags: VotableTagModel[] | undefined;
      report: (typeof reportVar)[number] | undefined;
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
      report: reportVar?.find((x) => x.imageId === i.id),
    })
  );

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
  const AND = [Prisma.sql`i.id = ${id}`];
  if (!isModerator)
    AND.push(
      Prisma.sql`(${Prisma.join(
        [
          Prisma.sql`i."needsReview" IS NULL AND i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
          Prisma.sql`i."userId" = ${userId}`,
        ],
        ' OR '
      )})`
    );

  const rawImages = await dbRead.$queryRaw<GetAllImagesRaw[]>`
    SELECT
      i.id,
      i.name,
      i.url,
      i.nsfw,
      i.height,
      i.width,
      i.index,
      i.hash,
      i.meta,
      i."hideMeta",
      i."generationProcess",
      i."createdAt",
      i."mimeType",
      i."scannedAt",
      i."needsReview",
      i."postId",
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      u.id "userId",
      u.username,
      u.image "userImage",
      u."deletedAt",
      (
        SELECT jsonb_agg(reaction)
        FROM "ImageReaction"
        WHERE "imageId" = i.id
        AND "userId" = ${userId}
      ) reactions
    FROM "Image" i
    JOIN "User" u ON u.id = i."userId"
    JOIN "Post" p ON p.id = i."postId" ${Prisma.raw(
      !isModerator ? 'AND p."publishedAt" < now()' : ''
    )}
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'::"MetricTimeframe"
    WHERE ${Prisma.join(AND, ' AND ')}
  `;
  if (!rawImages.length) throw throwNotFoundError(`No image with id ${id}`);

  const [
    {
      userId: creatorId,
      username,
      userImage,
      deletedAt,
      reactions,
      cryCount,
      laughCount,
      likeCount,
      dislikeCount,
      heartCount,
      commentCount,
      ...firstRawImage
    },
  ] = rawImages;

  const userCosmeticsRaw = await dbRead.userCosmetic.findMany({
    where: { userId: creatorId, equippedAt: { not: null } },
    select: {
      userId: true,
      cosmetic: { select: { id: true, data: true, type: true, source: true, name: true } },
    },
  });
  const userCosmetics = userCosmeticsRaw.reduce((acc, { userId, cosmetic }) => {
    acc[userId] = acc[userId] ?? [];
    acc[userId].push(cosmetic);
    return acc;
  }, {} as Record<number, (typeof userCosmeticsRaw)[0]['cosmetic'][]>);

  const image = {
    ...firstRawImage,
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
  };

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
  type: MediaType;
  metadata: Prisma.JsonValue;
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
    Prisma.sql`i."needsReview" IS NULL`,
  ];

  // ensure that only scanned images make it to the main feed
  imageWhere.push(
    Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
  );

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
      i.type,
      i.metadata,
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
  isOwnerRequest,
}: {
  postIds: number | number[];
  excludedTagIds?: number[];
  excludedIds?: number[];
  excludedUserIds?: number[];
  userId?: number;
  isOwnerRequest?: boolean;
}) => {
  if (!Array.isArray(postIds)) postIds = [postIds];
  const imageWhere: Prisma.Sql[] = [Prisma.sql`i."postId" IN (${Prisma.join(postIds)})`];

  if (!isOwnerRequest) {
    // ensure that only scanned images make it to the main feed
    imageWhere.push(
      Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );

    if (!!excludedTagIds?.length)
      imageWhere.push(
        Prisma.sql`NOT EXISTS (SELECT 1 FROM "TagsOnImage" toi WHERE toi."imageId" = i."id" AND toi.disabled = false AND toi."tagId" IN (${Prisma.join(
          excludedTagIds
        )}) )`
      );
    if (!!excludedIds?.length)
      imageWhere.push(Prisma.sql`i."id" NOT IN (${Prisma.join(excludedIds)})`);
    if (!!excludedUserIds?.length)
      imageWhere.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
  }
  const images = await dbRead.$queryRaw<
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
      type: MediaType;
      metadata: Prisma.JsonValue;
      reactions?: ReviewReactions[];
    }[]
  >`
    WITH targets AS (
      SELECT
        i."postId",
        MIN(i.index) "index",
        COUNT(*) "count"
      FROM "Image" i
      WHERE ${Prisma.join(imageWhere, ' AND ')}
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
      i.type,
      i.metadata,
      t."postId",
      t.count "imageCount",
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      (
        SELECT jsonb_agg(reaction)
        FROM "ImageReaction"
        WHERE "imageId" = i.id
        AND "userId" = ${userId}
      ) reactions
    FROM targets t
    JOIN "Image" i ON i."postId" = t."postId" AND i.index = t.index
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'
  `;

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

export function applyModRulesSql(
  AND: Prisma.Sql[],
  { userId, publishedOnly = true }: { userId?: number; publishedOnly?: boolean }
) {
  // Hide images that need review
  const needsReviewOr = [Prisma.sql`i."needsReview" IS NULL`];
  // Hide images that aren't published
  const publishedOr = publishedOnly ? [Prisma.sql`p."publishedAt" < now()`] : [];

  if (userId) {
    const belongsToUser = Prisma.sql`i."userId" = ${userId}`;
    needsReviewOr.push(belongsToUser);
    publishedOr.push(belongsToUser);
  }
  AND.push(Prisma.sql`(${Prisma.join(needsReviewOr, ' OR ')})`);
  if (publishedOr.length > 0) AND.push(Prisma.sql`(${Prisma.join(publishedOr, ' OR ')})`);
}

export async function applyAnonymousUserRules(excludedImageTags: number[]) {
  const allowedTags = await getAllowedAnonymousTags();
  for (const index in excludedImageTags)
    if (allowedTags.includes(excludedImageTags[index])) excludedImageTags.splice(Number(index), 1);
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
  type: MediaType;
  metadata: Prisma.JsonValue;
  scannedAt: Date;
  needsReview: string | null;
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
  categories = categories.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.random() - 0.5;
  });

  const AND = [Prisma.sql`p."publishedAt" < now()`];

  // ensure that only scanned images make it to the main feed
  AND.push(Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`);

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
            : 'AND p."publishedAt" < now()'
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
      LIMIT ${input.imageLimit ?? 21}
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
        i.type,
        i.metadata,
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
        reactions: userId
          ? reactions
              .filter((r) => r.imageId === x.id)
              .map((r) => ({ userId, reaction: r.reaction }))
          : [],
      }));
    return { ...c, items };
  });

  return { items, nextCursor };
};

export type GetIngestionResultsProps = AsyncReturnType<typeof getIngestionResults>;
export const getIngestionResults = async ({ ids, userId }: { ids: number[]; userId?: number }) => {
  const images = await dbRead.image.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      ingestion: true,
      blockedFor: true,
      tagComposites: {
        where: { OR: [{ score: { gt: 0 } }, { tagType: 'Moderation' }] },
        select: imageTagCompositeSelect,
        orderBy: { score: 'desc' },
      },
    },
  });

  const dictionary = images.reduce<
    Record<
      number,
      { ingestion: ImageIngestionStatus; blockedFor?: string; tags?: VotableTagModel[] }
    >
  >((acc, value) => {
    const { id, ingestion, blockedFor, tagComposites } = value;
    const tags: VotableTagModel[] = tagComposites.map(
      ({ tagId, tagName, tagType, tagNsfw, ...tag }) => ({
        ...tag,
        id: tagId,
        type: tagType,
        nsfw: tagNsfw,
        name: tagName,
      })
    );
    return {
      ...acc,
      [id]: {
        ingestion,
        blockedFor: blockedFor ?? undefined,
        tags: !!blockedFor ? undefined : tags,
      },
    };
  }, {});

  if (userId) {
    const userVotes = await dbRead.tagsOnImageVote.findMany({
      where: { imageId: { in: ids }, userId },
      select: { tagId: true, vote: true },
    });

    for (const key in dictionary) {
      if (dictionary.hasOwnProperty(key)) {
        for (const tag of dictionary[key].tags ?? []) {
          const userVote = userVotes.find((vote) => vote.tagId === tag.id);
          if (userVote) tag.vote = userVote.vote > 0 ? 1 : -1;
        }
      }
    }
  }

  return dictionary;
};
