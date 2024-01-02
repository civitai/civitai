import {
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

import { TRPCError } from '@trpc/server';
import { chunk } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { isDev, isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { nsfwLevelOrder } from '~/libs/moderation';
import { VotableTagModel } from '~/libs/tags';
import { BlockedReason, ImageScanType, ImageSort } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import {
  GetEntitiesCoverImage,
  ImageEntityType,
  ImageReviewQueueInput,
  ImageUploadProps,
  UpdateImageInput,
} from '~/server/schema/image.schema';
import { imagesSearchIndex } from '~/server/search-index';
import { ImageV2Model } from '~/server/selectors/imagev2.selector';
import { imageTagCompositeSelect, simpleTagSelect } from '~/server/selectors/tag.selector';
import { updatePostNsfwLevel } from '~/server/services/post.service';
import { getTagsNeedingReview } from '~/server/services/system-cache';
import { getTypeCategories } from '~/server/services/tag.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { logToDb } from '~/utils/logging';
import { deleteObject } from '~/utils/s3-utils';
import { hashifyObject } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
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
import { ImageResourceHelperModel, profileImageSelect } from '~/server/selectors/image.selector';
import { purgeCache } from '~/server/cloudflare/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { promptWordReplace } from '~/utils/metadata/audit';
import { getCursor } from '~/server/utils/pagination-helpers';
import { cachedObject, queryCache } from '~/server/utils/cache-helpers';
import { CacheTTL } from '~/server/common/constants';
import { getPeriods } from '~/server/utils/enum-helpers';
// TODO.ingestion - logToDb something something 'axiom'

// no user should have to see images on the site that haven't been scanned or are queued for removal

export const imageUrlInUse = async ({ url, id }: { url: string; id: number }) => {
  const otherImagesWithSameUrl = await dbRead.image.findFirst({
    select: { id: true },
    where: {
      url: url,
      id: { not: id },
    },
  });

  return !!otherImagesWithSameUrl;
};

export const deleteImageById = async ({ id }: GetByIdInput) => {
  try {
    const image = await dbRead.image.findUnique({
      where: { id },
      select: { url: true, postId: true, nsfw: true, userId: true },
    });
    if (!image) return;

    if (isProd && !(await imageUrlInUse({ url: image.url, id })))
      await deleteObject(env.S3_IMAGE_UPLOAD_BUCKET, image.url); // Remove from storage

    await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
    await dbWrite.image.deleteMany({ where: { id } });
    if (image.postId) await updatePostNsfwLevel(image.postId);
    return image;
  } catch {
    // Ignore errors
  }
};

// consider refactoring this endoint to only allow for updating `needsReview`, because that is all this endpoint is being used for...
export const updateImageById = async ({
  id,
  data,
}: {
  id: number;
  data: Prisma.ImageUpdateArgs['data'];
}) => {
  const image = await dbWrite.image.update({ where: { id }, data });

  if (image.tosViolation) {
    await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
  }

  return image;
};

export const moderateImages = async ({
  ids,
  nsfw,
  needsReview,
  reviewType,
  reviewAction,
}: ImageModerationSchema) => {
  if (reviewAction === 'delete') {
    if (reviewType !== 'reported') {
      await dbWrite.image.updateMany({
        where: { id: { in: ids }, needsReview: { not: null } },
        data: {
          nsfw,
          needsReview: null,
          ingestion: 'Blocked',
          blockedFor: BlockedReason.Moderated,
        },
      });
    } else {
      const images = await dbRead.image.findMany({
        where: { id: { in: ids } },
        select: { postId: true },
      });
      await dbWrite.image.deleteMany({ where: { id: { in: ids } } });
      const postIds = images.map((x) => x.postId).filter(isDefined);
      await updatePostNsfwLevel(postIds);
    }

    await imagesSearchIndex.queueUpdate(
      ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Delete }))
    );
  } else if (reviewAction === 'removeName') {
    removeNameReference(ids);
  } else {
    await dbWrite.image.updateMany({
      where: { id: { in: ids } },
      data: { nsfw, needsReview, ingestion: 'Scanned' },
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

export const ingestImageById = async ({ id }: GetByIdInput) => {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: {
      id: true,
      url: true,
      type: true,
      width: true,
      height: true,
    },
  });
  if (!image) throw new TRPCError({ code: 'NOT_FOUND' });
  return await ingestImage({ image });
};

export const ingestImage = async ({
  image,
  tx,
}: {
  image: IngestImageInput;
  tx?: Prisma.TransactionClient;
}): Promise<boolean> => {
  if (!env.IMAGE_SCANNING_ENDPOINT)
    throw new Error('missing IMAGE_SCANNING_ENDPOINT environment variable');
  const { url, id, type, width, height } = ingestImageSchema.parse(image);

  const callbackUrl = env.IMAGE_SCANNING_CALLBACK;
  const scanRequestedAt = new Date();
  const dbClient = tx ?? dbWrite;

  if (!isProd && !callbackUrl) {
    console.log('skip ingest');
    await dbClient.image.update({
      where: { id },
      data: {
        scanRequestedAt,
        scannedAt: scanRequestedAt,
        ingestion: ImageIngestionStatus.Scanned,
      },
    });

    return true;
  }
  const response = await fetch(env.IMAGE_SCANNING_ENDPOINT + '/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageId: id,
      imageKey: url,
      type,
      width,
      height,
      // wait: true,
      scans: [ImageScanType.Label, ImageScanType.Moderation, ImageScanType.WD14],
      callbackUrl,
    }),
  });
  if (response.status === 202) {
    const scanJobs = (await response.json().catch(() => Prisma.JsonNull)) as { jobId: string };
    await dbClient.image.update({
      where: { id },
      data: { scanRequestedAt, scanJobs },
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

export const ingestImageBulk = async ({
  images,
  tx,
  lowPriority = true,
}: {
  images: IngestImageInput[];
  tx?: Prisma.TransactionClient;
  lowPriority?: boolean;
}): Promise<boolean> => {
  if (!env.IMAGE_SCANNING_ENDPOINT)
    throw new Error('missing IMAGE_SCANNING_ENDPOINT environment variable');

  const callbackUrl = env.IMAGE_SCANNING_CALLBACK;
  const scanRequestedAt = new Date();
  const imageIds = images.map(({ id }) => id);
  const dbClient = tx ?? dbWrite;

  if (!isProd && !callbackUrl) {
    console.log('skip ingest');
    await dbClient.image.updateMany({
      where: { id: { in: imageIds } },
      data: {
        scanRequestedAt,
        scannedAt: scanRequestedAt,
        ingestion: ImageIngestionStatus.Scanned,
      },
    });
    return true;
  }

  const response = await fetch(
    env.IMAGE_SCANNING_ENDPOINT + `/enqueue-bulk?lowpri=${lowPriority}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        images.map((image) => ({
          imageId: image.id,
          imageKey: image.url,
          type: image.type,
          width: image.width,
          height: image.height,
          scans: [ImageScanType.Label, ImageScanType.Moderation, ImageScanType.WD14],
          callbackUrl,
        }))
      ),
    }
  );
  if (response.status === 202) {
    await dbClient.image.updateMany({
      where: { id: { in: imageIds } },
      data: { scanRequestedAt },
    });
    return true;
  }
  return false;
};

// #region [new service methods]
export function applyUserPreferencesSql(
  AND: Prisma.Sql[],
  {
    excludedUserIds,
    excludedImageIds,
    excludedTagIds,
    userId,
    hidden,
  }: UserPreferencesInput & { userId?: number; hidden?: boolean }
) {
  // Exclude specific users
  if (excludedUserIds?.length)
    AND.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);

  // Exclude specific images
  if (excludedImageIds?.length) {
    AND.push(
      hidden
        ? Prisma.sql`i."id" IN (${Prisma.join(excludedImageIds)})`
        : Prisma.sql`i."id" NOT IN (${Prisma.join(excludedImageIds)})`
    );
  }

  // Exclude specific tags
  if (excludedTagIds?.length) {
    const OR = [
      Prisma.join(
        [
          Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
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
  ingestion: ImageIngestionStatus;
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
  tippedAmountCount: number;
  viewCount: number;
  cursorId?: bigint;
  type: MediaType;
  metadata: Prisma.JsonValue;
  baseModel?: string;
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
  include,
  nsfw,
  excludeCrossPosts,
  reactions,
  ids,
  includeBaseModel,
  types,
  hidden,
  followed,
}: GetInfiniteImagesInput & {
  userId?: number;
  isModerator?: boolean;
  nsfw?: NsfwLevel;
  headers?: Record<string, string>;
}) => {
  const AND: Prisma.Sql[] = [Prisma.sql`i."postId" IS NOT NULL`];
  const WITH: Prisma.Sql[] = [];
  let orderBy: string;
  const cacheTags: string[] = [];
  let cacheTime = CacheTTL.xs;

  const showClubPosts = !!postId || !!collectionId || !!modelId || !!modelVersionId || !!reviewId;

  if (hidden && !userId) throw throwAuthorizationError();
  if (hidden && (excludedImageIds ?? []).length === 0) {
    return { items: [], nextCursor: undefined };
  }

  if (excludeCrossPosts && modelVersionId) {
    cacheTime = CacheTTL.day;
    cacheTags.push(`images-modelVersion:${modelVersionId}`);
    AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);
  }

  if (ids && ids.length > 0) {
    AND.push(Prisma.sql`i."id" IN (${Prisma.join(ids)})`);
  }

  if (types && types.length > 0) {
    AND.push(Prisma.sql`i.type = ANY(ARRAY[${Prisma.join(types)}]::"MediaType"[])`);
  }

  if (include.includes('meta')) {
    AND.push(Prisma.sql`NOT (i.meta IS NULL OR jsonb_typeof(i.meta) = 'null')`);
  }

  let from = 'FROM "Image" i';
  const joins: string[] = [];
  // Filter to specific model/review content
  const prioritizeUser = !!prioritizedUserIds?.length;
  if (!prioritizeUser && (modelId || modelVersionId || reviewId)) {
    from = `FROM "ImageResource" irr`;
    joins.push(`JOIN "Image" i ON i.id = irr."imageId"`);
    if (reviewId) {
      joins.push(`JOIN "ResourceReview" re ON re."modelVersionId" = irr."modelVersionId"`);
      AND.push(Prisma.sql`re."id" = ${reviewId}`);
      cacheTime = 0;
    } else if (modelVersionId) {
      AND.push(Prisma.sql`irr."modelVersionId" = ${modelVersionId}`);
      cacheTime = CacheTTL.day;
      cacheTags.push(`images-modelVersion:${modelVersionId}`);
    } else if (modelId) {
      joins.push(`JOIN "ModelVersion" mv ON mv.id = irr."modelVersionId"`);
      AND.push(Prisma.sql`mv."modelId" = ${modelId}`);
      cacheTime = CacheTTL.day;
      cacheTags.push(`images-model:${modelId}`);
    }
  }

  // Filter to specific user content
  if (username) {
    const targetUser = await dbRead.user.findUnique({ where: { username }, select: { id: true } });
    if (!targetUser) throw new Error('User not found');
    AND.push(Prisma.sql`u."id" = ${targetUser.id}`);
    // Don't cache self queries
    if (targetUser.id !== userId) {
      cacheTime = CacheTTL.day;
      cacheTags.push(`images-user:${targetUser.id}`);
    } else cacheTime = 0;
  }

  // Filter only followed users
  if (userId && followed) {
    const followedUsers = await dbRead.user.findUnique({
      where: { id: userId },
      select: {
        engagingUsers: {
          select: { targetUser: { select: { id: true } } },
          where: { type: 'Follow' },
        },
      },
    });
    const followedUsersIds =
      followedUsers?.engagingUsers?.map(({ targetUser }) => targetUser.id) ?? [];
    AND.push(
      Prisma.sql`i."userId" IN (${
        followedUsersIds.length > 0 ? Prisma.join(followedUsersIds) : null
      })`
    );
    cacheTime = 0;
  }

  // Filter to specific tags
  if (tags?.length) {
    AND.push(Prisma.sql`i.id IN (
      SELECT "imageId"
      FROM "TagsOnImage"
      WHERE "tagId" IN (${Prisma.join(tags)}) AND "disabledAt" IS NULL
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

  if (sort === ImageSort.Random && !collectionId) {
    throw throwBadRequestError('Random sort requires a collectionId');
  }

  // Filter to a specific collection and relevant status:
  if (collectionId) {
    const displayOwnedItems = userId
      ? ` OR (ci."status" <> 'REJECTED' AND ci."addedById" = ${userId})`
      : '';
    if (userId) cacheTime = 0;
    const useRandomCursor = cursor && sort === ImageSort.Random;

    WITH.push(
      Prisma.sql`
        ${Prisma.raw(
          useRandomCursor
            ? `
        ctcursor AS (
          SELECT ci."imageId", ci."randomId" FROM "CollectionItem" ci
            WHERE ci."collectionId" = ${collectionId}
              AND ci."imageId" = ${cursor}
            LIMIT 1
        ),
        `
            : ''
        )}
        ct AS (
          SELECT ci."imageId", ci."randomId"
          FROM "CollectionItem" ci
          JOIN "Collection" c ON c.id = ci."collectionId"
          WHERE ci."collectionId" = ${collectionId}
            AND ci."imageId" IS NOT NULL
            AND (
              (
                ci."status" = 'ACCEPTED'
                AND (
                  (c.metadata::json->'submissionEndDate') IS NULL
                  OR (c.metadata::json->'submissionEndDate')::TEXT = 'null'
                  OR (c.metadata::json->>'submissionEndDate')::TIMESTAMP WITH TIME ZONE <= NOW()
                )
                ${Prisma.raw(sort === ImageSort.Random ? `AND ci."randomId" IS NOT NULL` : '')}
              )
              ${Prisma.raw(displayOwnedItems)}
            )
            ${Prisma.raw(
              useRandomCursor ? `AND ci."randomId" <= (SELECT "randomId" FROM ctcursor)` : ''
            )}
          ${Prisma.raw(sort === ImageSort.Random ? 'ORDER BY "randomId" DESC' : '')}
        )`
    );
  }

  const isGallery = modelId || modelVersionId || reviewId || username;
  if (postId && !modelId) {
    // a post image query won't include modelId
    orderBy = `i."index"`;
  } else {
    // Sort by selected sort
    if (sort === ImageSort.MostComments) {
      orderBy = `im."commentCount" DESC, im."reactionCount" DESC, im."imageId"`;
      if (!isGallery) AND.push(Prisma.sql`im."commentCount" > 0`);
    } else if (sort === ImageSort.MostReactions) {
      orderBy = `im."reactionCount" DESC, im."heartCount" DESC, im."likeCount" DESC, im."imageId"`;
      if (!isGallery) AND.push(Prisma.sql`im."reactionCount" > 0`);
    } else if (sort === ImageSort.MostCollected) {
      orderBy = `im."collectedCount" DESC, im."reactionCount" DESC, im."imageId"`;
      if (!isGallery) AND.push(Prisma.sql`im."collectedCount" > 0`);
    } else if (sort === ImageSort.MostTipped) {
      orderBy = `im."tippedAmountCount" DESC, im."reactionCount" DESC, im."imageId"`;
      if (!isGallery) AND.push(Prisma.sql`im."tippedAmountCount" > 0`);
    } else if (sort === ImageSort.Random) orderBy = 'ct."randomId" DESC';
    else {
      if (from.indexOf(`irr`) !== -1) {
        // Ensure to sort by irr.imageId when reading from imageResources to maximize index utilization
        orderBy = `irr."imageId" DESC`;
      } else {
        orderBy = `i."id" DESC`;
      }
    }
  }

  if (hidden) {
    cacheTime = 0;
    AND.push(Prisma.sql`i."id" IN (${Prisma.join(excludedImageIds ?? [])})`);
  }

  if (nsfw === NsfwLevel.None) AND.push(Prisma.sql`i."nsfw" = 'None'`);
  else if (nsfw !== undefined) {
    const nsfwLevels = nsfwLevelOrder.slice(1, nsfwLevelOrder.indexOf(nsfw) + 1);
    AND.push(Prisma.sql`i."nsfw" = ANY(ARRAY[${Prisma.join(nsfwLevels)}]::"NsfwLevel"[])`);
  }

  // Limit to images created since period start
  if (period !== 'AllTime' && periodMode !== 'stats') {
    const ageGroups = getPeriods(period);
    AND.push(
      Prisma.sql`im."ageGroup" = ANY(ARRAY[${Prisma.join(ageGroups)}]::"MetricTimeframe"[])`
    );
  }

  // Handle cursor & skip conflict
  if (cursor && skip) throw new Error('Cannot use skip with cursor');

  // Handle cursor prop
  let { where: cursorClause, prop: cursorProp } = getCursor(orderBy, cursor);
  if (sort === ImageSort.Random) {
    cursorProp = 'i."id"';
    cursorClause = undefined;
  }
  if (cursorClause) AND.push(cursorClause);

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
    cacheTime = 0;
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

  // TODO: Availability query seems to be killing us. Need to figure out how to optimize this.
  // At the moment, club-required images will show up in the feed.
  if (!showClubPosts) {
    AND.push(Prisma.sql`p."availability" != 'Private'`);
  }

  // TODO: Adjust ImageMetric
  const queryFrom = Prisma.sql`
    ${Prisma.raw(from)}
    ${Prisma.raw(joins.join('\n'))}
    JOIN "User" u ON u.id = i."userId"
    JOIN "Post" p ON p.id = i."postId"
    ${Prisma.raw(WITH.length && collectionId ? `JOIN ct ON ct."imageId" = i.id` : '')}
    ${Prisma.raw(
      isDev ? 'LEFT ' : ''
    )}JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'::"MetricTimeframe"
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;
  const query = Prisma.sql`
    ${queryWith}
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
      i.ingestion,
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
      ${Prisma.raw(
        includeBaseModel
          ? `(
        SELECT mv."baseModel" FROM "ModelVersion" mv
        RIGHT JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" = mv.id
        JOIN "Model" m ON mv."modelId" = m.id
        WHERE m."type" = 'Checkpoint'
        LIMIT 1
      ) "baseModel",`
          : ''
      )}
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      COALESCE(im."tippedAmountCount", 0) "tippedAmountCount",
      COALESCE(im."viewCount", 0) "viewCount",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
      ${queryFrom}
      ORDER BY ${Prisma.raw(orderBy)}
      ${Prisma.raw(skip ? `OFFSET ${skip}` : '')}
      LIMIT ${limit + 1}
  `;

  if (!env.IMAGE_QUERY_CACHING) cacheTime = 0;
  const cacheable = queryCache(dbRead, 'getAllImages', 'v1');
  const rawImages = await cacheable<GetAllImagesRaw[]>(query, { ttl: cacheTime, tag: cacheTags });

  const imageIds = rawImages.map((i) => i.id);
  let userReactions: Record<number, ReviewReactions[]> | undefined;
  if (userId) {
    const reactionsRaw = await dbRead.imageReaction.findMany({
      where: { imageId: { in: imageIds }, userId },
      select: { imageId: true, reaction: true },
    });
    userReactions = reactionsRaw.reduce((acc, { imageId, reaction }) => {
      acc[imageId] ??= [] as ReviewReactions[];
      acc[imageId].push(reaction);
      return acc;
    }, {} as Record<number, ReviewReactions[]>);
  }

  let nextCursor: bigint | undefined;
  if (rawImages.length > limit) {
    const nextItem = rawImages.pop();
    nextCursor = nextItem?.cursorId;
  }

  let tagIdsVar: Record<string, { tags: number[]; imageId: number }> | undefined;
  if (include?.includes('tagIds')) {
    tagIdsVar = await getTagIdsForImages(imageIds);
  }

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined;
  if (include?.includes('tags')) {
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
  const userIds = rawImages.map((i) => i.userId);
  const userCosmetics = include?.includes('cosmetics')
    ? await getCosmeticsForUsers(userIds)
    : undefined;
  const profilePictures = include?.includes('profilePictures')
    ? await getProfilePicturesForUsers(userIds)
    : undefined;

  const now = new Date();
  const images: Array<
    ImageV2Model & {
      tags?: VotableTagModel[] | undefined;
      tagIds?: number[];
      publishedAt?: Date | null;
      modelVersionId?: number | null;
      baseModel?: string | null;
    }
  > = rawImages
    .filter((x) => {
      // Filter out images that shouldn't be seen by user
      if (isModerator) return true;
      if (x.needsReview && x.userId !== userId) return false;
      if ((!x.publishedAt || x.publishedAt > now) && x.userId !== userId) return false;
      if (x.ingestion !== 'Scanned' && x.userId !== userId) return false;
      return true;
    })
    .map(
      ({
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
        tippedAmountCount,
        viewCount,
        cursorId,
        ...i
      }) => ({
        ...i,
        user: {
          id: creatorId,
          username,
          image: userImage,
          deletedAt,
          cosmetics: userCosmetics?.[creatorId] ?? [],
          profilePicture: profilePictures?.[creatorId] ?? null,
        },
        stats: {
          cryCountAllTime: cryCount,
          laughCountAllTime: laughCount,
          likeCountAllTime: likeCount,
          dislikeCountAllTime: dislikeCount,
          heartCountAllTime: heartCount,
          commentCountAllTime: commentCount,
          tippedAmountCountAllTime: tippedAmountCount,
          viewCountAllTime: viewCount,
        },
        reactions:
          userReactions?.[i.id]?.map((r) => ({ userId: userId as number, reaction: r })) ?? [],
        tags: tagsVar?.filter((x) => x.imageId === i.id),
        tagIds: tagIdsVar?.[i.id]?.tags,
      })
    );

  return {
    nextCursor,
    items: images,
  };
};

async function tagLookup(imageId: number | number[], fromWrite = false) {
  const imageIds = Array.isArray(imageId) ? imageId : [imageId];
  const db = fromWrite ? dbWrite : dbRead;
  const tags = await db.tagsOnImage.findMany({
    where: { imageId: { in: imageIds }, disabled: false },
    select: { tagId: true, imageId: true },
  });

  const result = tags.reduce((acc, { tagId, imageId }) => {
    acc[imageId.toString()] ??= { imageId, tags: [] };
    acc[imageId.toString()].tags.push(tagId);
    return acc;
  }, {} as Record<string, { imageId: number; tags: number[] }>);
  return result;
}

export async function getTagIdsForImages(imageIds: number[]) {
  return await cachedObject<{ imageId: number; tags: number[] }>({
    key: 'tagIdsForImages',
    idKey: 'imageId',
    ids: imageIds,
    ttl: CacheTTL.day,
    lookupFn: tagLookup,
  });
}

export async function clearImageTagIdsCache(imageId: number | number[]) {
  const imageIds = Array.isArray(imageId) ? imageId : [imageId];
  if (!imageIds.length) return;

  await redis.hDel(
    'tagIdsForImages',
    imageIds.map((x) => x.toString())
  );
}

export async function updateImageTagIdsForImages(imageId: number | number[]) {
  const results = await tagLookup(imageId, true);
  if (Object.keys(results).length === 0) return;

  const cachedAt = Date.now();
  const toCache = Object.fromEntries(
    Object.entries(results).map(([key, x]) => [key, JSON.stringify({ ...x, cachedAt })])
  );
  await redis.hSet('tagIdsForImages', toCache);
}

type GetImageRaw = GetAllImagesRaw & {
  reactions?: ReviewReactions[];
  postId?: number | null;
};
export const getImage = async ({
  id,
  userId,
  isModerator,
  withoutPost,
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

  const rawImages = await dbRead.$queryRaw<GetImageRaw[]>`
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
      i.ingestion,
      i.type,
      i.metadata,
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      COALESCE(im."tippedAmountCount", 0) "tippedAmountCount",
      COALESCE(im."viewCount", 0) "viewCount",
      u.id "userId",
      u.username,
      u.image "userImage",
      u."deletedAt",
      u."profilePictureId",
      (
        SELECT jsonb_agg(reaction)
        FROM "ImageReaction"
        WHERE "imageId" = i.id
        AND "userId" = ${userId}
      ) reactions
    FROM "Image" i
    JOIN "User" u ON u.id = i."userId"
    ${Prisma.raw(
      withoutPost
        ? ''
        : // Now that moderators can review images without post, we need to make this optional
          // in case they land in an image-specific review flow
          `${isModerator ? 'LEFT ' : ''}JOIN "Post" p ON p.id = i."postId" ${
            !isModerator ? 'AND p."publishedAt" < now()' : ''
          }`
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
      tippedAmountCount,
      viewCount,
      ...firstRawImage
    },
  ] = rawImages;

  const userCosmetics = await getCosmeticsForUsers([creatorId]);
  const profilePictures = await getProfilePicturesForUsers([creatorId]);

  const image = {
    ...firstRawImage,
    user: {
      id: creatorId,
      username,
      image: userImage,
      deletedAt,
      cosmetics: userCosmetics?.[creatorId] ?? [],
      profilePicture: profilePictures?.[creatorId] ?? null,
    },
    stats: {
      cryCountAllTime: cryCount,
      laughCountAllTime: laughCount,
      likeCountAllTime: likeCount,
      dislikeCountAllTime: dislikeCount,
      heartCountAllTime: heartCount,
      commentCountAllTime: commentCount,
      tippedAmountCountAllTime: tippedAmountCount,
      viewCountAllTime: viewCount,
    },
    reactions: userId ? reactions?.map((r) => ({ userId, reaction: r })) ?? [] : [],
  };

  return image;
};

export const getImageResources = async ({ id }: GetByIdInput) => {
  const resources = await dbRead.$queryRaw<ImageResourceHelperModel[]>`
    SELECT
      irh."id",
      irh."reviewId",
      irh."reviewRating",
      irh."reviewDetails",
      irh."reviewCreatedAt",
      irh."name",
      irh."hash",
      irh."modelVersionId",
      irh."modelVersionName",
      irh."modelVersionCreatedAt",
      irh."modelId",
      irh."modelName",
      irh."modelRating",
      irh."modelRatingCount",
      irh."modelDownloadCount",
      irh."modelCommentCount",
      irh."modelFavoriteCount",
      irh."modelType"
    FROM
      "ImageResourceHelper" irh
    JOIN "Model" m ON m.id = irh."modelId" AND m."status" = 'Published'
    WHERE
      irh."imageId" = ${Prisma.sql`${id}`}
    AND (irh."hash" IS NOT NULL OR irh."modelVersionId" IS NOT NULL)
  `;

  return resources;
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
  tags?: number[];
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
  include?: Array<'meta' | 'tags'>;
}) => {
  if (!Array.isArray(modelVersionIds)) modelVersionIds = [modelVersionIds];
  if (!modelVersionIds.length) return [] as ImagesForModelVersions[];

  const imageWhere: Prisma.Sql[] = [
    Prisma.sql`p."modelVersionId" IN (${Prisma.join(modelVersionIds)})`,
    Prisma.sql`i."needsReview" IS NULL`,
  ];

  // ensure that only scanned images make it to the main feed
  // nb: if image ingestion fails, models will not make it to any model feed (including the user published tab)
  if (isProd) {
    imageWhere.push(
      Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );
  }

  if (!!excludedTagIds?.length) {
    const excludedTagsOr: Prisma.Sql[] = [
      Prisma.join(
        [
          Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
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
    ORDER BY i."postId", i."index"
  `;

  if (include.includes('tags')) {
    const tags = await dbRead.tagsOnImage.findMany({
      where: { imageId: { in: images.map((i) => i.id) }, disabled: false },
      select: { imageId: true, tagId: true },
    });
    for (const image of images) {
      image.tags = tags.filter((t) => t.imageId === image.id).map((t) => t.tagId);
    }
  }

  return images;
};

export const getImagesForPosts = async ({
  postIds,
  excludedIds,
  userId,
  isOwnerRequest,
  coverOnly = true,
}: {
  postIds: number | number[];
  excludedIds?: number[];
  userId?: number;
  isOwnerRequest?: boolean;
  coverOnly?: boolean;
}) => {
  if (!Array.isArray(postIds)) postIds = [postIds];
  const imageWhere: Prisma.Sql[] = [
    Prisma.sql`i."postId" IN (${Prisma.join(postIds)})`,
    Prisma.sql`i."needsReview" IS NULL`,
  ];

  if (!isOwnerRequest) {
    // ensure that only scanned images make it to the main feed
    imageWhere.push(
      Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );

    if (!!excludedIds?.length)
      imageWhere.push(Prisma.sql`i."id" NOT IN (${Prisma.join(excludedIds)})`);
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
      createdAt: Date;
      generationProcess: ImageGenerationProcess | null;
      postId: number;
      imageCount: number;
      cryCount: number;
      laughCount: number;
      likeCount: number;
      dislikeCount: number;
      heartCount: number;
      commentCount: number;
      tippedAmountCount: number;
      type: MediaType;
      metadata: Prisma.JsonValue;
      meta?: Prisma.JsonValue;
      reactions?: ReviewReactions[];
    }[]
  >`
    WITH targets AS (
      SELECT
        i."postId",
        ${Prisma.raw(coverOnly ? 'MIN(i.index) "index",' : '')}
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
      i.meta,
      i."createdAt",
      i."generationProcess",
      t."postId",
      t.count "imageCount",
      COALESCE(im."cryCount", 0) "cryCount",
      COALESCE(im."laughCount", 0) "laughCount",
      COALESCE(im."likeCount", 0) "likeCount",
      COALESCE(im."dislikeCount", 0) "dislikeCount",
      COALESCE(im."heartCount", 0) "heartCount",
      COALESCE(im."commentCount", 0) "commentCount",
      COALESCE(im."tippedAmountCount", 0) "tippedAmountCount",
      (
        SELECT jsonb_agg(reaction)
        FROM "ImageReaction"
        WHERE "imageId" = i.id
        AND "userId" = ${userId}
      ) reactions
    FROM targets t
    JOIN "Image" i ON i."postId" = t."postId" ${Prisma.raw(
      coverOnly ? 'AND i.index = t.index' : ''
    )}
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'
  `;
  const imageIds = images.map((i) => i.id);
  const rawTags =
    imageIds?.length > 0
      ? await dbRead.imageTag.findMany({
          where: { imageId: { in: imageIds } },
          select: {
            imageId: true,
            tagId: true,
          },
        })
      : [];

  return images.map(({ reactions, ...i }) => ({
    ...i,
    meta: (i.meta ?? {}) as ImageMetaProps,
    tagIds: rawTags.filter((t) => t.imageId === i.id).map((t) => t.tagId),
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

    purgeCache({ tags: [`image-resources-${id}`] });

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

    if (publishedOnly) {
      publishedOr.push(belongsToUser);
    }
  }

  AND.push(Prisma.sql`(${Prisma.join(needsReviewOr, ' OR ')})`);

  if (publishedOr.length > 0) {
    AND.push(Prisma.sql`(${Prisma.join(publishedOr, ' OR ')})`);
  }
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
  ingestion: ImageIngestionStatus;
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
  tippedAmountCount: number;
  userId?: number;
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
    const exclusions =
      (input.excludedImageIds?.length ?? 0) +
      (input.excludedTagIds?.length ?? 0) +
      (input.excludedUserIds?.length ?? 0);
    const queryHeader = Object.entries({
      exclusions,
      cursor: input.cursor,
      limit: input.limit,
    })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

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
        i.ingestion,
        u.username,
        u.image AS "userImage",
        i."createdAt",
        p."publishedAt",
        u.id AS "userId",
        COALESCE(im."cryCount", 0) "cryCount",
        COALESCE(im."laughCount", 0) "laughCount",
        COALESCE(im."likeCount", 0) "likeCount",
        COALESCE(im."dislikeCount", 0) "dislikeCount",
        COALESCE(im."heartCount", 0) "heartCount",
        COALESCE(im."commentCount", 0) "commentCount",
        COALESCE(im."tippedAmountCount", 0) "tippedAmountCount"
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
        userId: x.userId || undefined,
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

type GetImageConnectionRaw = {
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
  ingestion: ImageIngestionStatus;
  needsReview: string | null;
  userId: number;
  index: number;
  type: MediaType;
  metadata: Prisma.JsonValue;
  entityId: number;
};

export const getImagesByEntity = async ({
  id,
  ids,
  type,
  imagesPerId = 4,
  include,
  userId,
  isModerator,
}: {
  id?: number;
  ids?: number[];
  type: ImageEntityType;
  imagesPerId?: number;
  include?: ['tags'];
  userId?: number;
  isModerator?: boolean;
}) => {
  if (!id && (!ids || ids.length === 0)) {
    return [];
  }

  const AND: Prisma.Sql[] = [
    Prisma.sql`(i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"${
      userId ? Prisma.sql` OR i."userId" = ${userId}` : Prisma.sql``
    })`,
  ];

  if (!isModerator) {
    const needsReviewOr = [
      Prisma.sql`i."needsReview" IS NULL`,
      userId ? Prisma.sql`i."userId" = ${userId}` : null,
    ].filter(isDefined);

    if (needsReviewOr.length > 0) {
      AND.push(Prisma.sql`(${Prisma.join(needsReviewOr, ' OR ')})`);
    }
  }

  const images = await dbRead.$queryRaw<GetImageConnectionRaw[]>`
    WITH targets AS (
      SELECT
        id,
        "entityId"
      FROM (
        SELECT
          i.id,
          ic."entityId",
          row_number() OVER (PARTITION BY ic."entityId" ORDER BY i.index) row_num
        FROM "Image" i
        JOIN "ImageConnection" ic ON ic."imageId" = i.id
            AND ic."entityType" = ${type}
            AND ic."entityId" IN (${Prisma.join(ids ? ids : [id])})
        WHERE ${Prisma.join(AND, ' AND ')}
      ) ranked
      WHERE ranked.row_num <= ${imagesPerId}
    )
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
      i.ingestion,
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."index",
      t."entityId"
    FROM targets t
    JOIN "Image" i ON i.id = t.id`;

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined = [];
  if (include && include.includes('tags')) {
    const imageIds = images.map((i) => i.id);
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
  }

  return images.map((i) => ({
    ...i,
    tags: tagsVar?.filter((x) => x.imageId === i.id),
  }));
};

export const createEntityImages = async ({
  tx,
  entityId,
  entityType,
  images,
  userId,
}: {
  tx?: Prisma.TransactionClient;
  entityId?: number;
  entityType?: string;
  images: ImageUploadProps[];
  userId: number;
}) => {
  const dbClient = tx ?? dbWrite;

  if (images.length === 0) {
    return [];
  }

  await dbClient.image.createMany({
    data: images.map((image) => ({
      ...image,
      meta: (image?.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      userId,
      resources: undefined,
    })),
  });

  const imageRecords = await dbClient.image.findMany({
    select: { id: true, url: true, type: true, width: true, height: true },
    where: {
      url: { in: images.map((i) => i.url) },
      ingestion: ImageIngestionStatus.Pending,
      userId,
    },
  });

  const batches = chunk(imageRecords, 50);
  for (const batch of batches) {
    await Promise.all(batch.map((image) => ingestImage({ image, tx: dbClient })));
  }

  if (entityType && entityId) {
    await dbClient.imageConnection.createMany({
      data: imageRecords.map((image) => ({
        imageId: image.id,
        entityId,
        entityType,
      })),
    });
  }

  return imageRecords;
};

type GetEntityImageRaw = {
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
  type: MediaType;
  metadata: Prisma.JsonValue;
  entityId: number;
  entityType: string;
};

export const getEntityCoverImage = async ({
  entities,
  include,
}: GetEntitiesCoverImage & {
  include?: ['tags'];
}) => {
  if (entities.length === 0) {
    return [];
  }

  // Returns 1 cover image for:
  // Models, Images, Bounties, BountyEntries.
  const images = await dbRead.$queryRaw<GetEntityImageRaw[]>`
    WITH entities AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(entities)}::jsonb) AS v(
        "entityId" INTEGER,
        "entityType" VARCHAR
      )
    ), targets AS (
      SELECT
        e."entityId",
        e."entityType",
        CASE
        WHEN e."entityType" = 'Model'
            THEN  (
                SELECT mi."imageId" FROM (
                  SELECT
                    m.id,
                    i.id as "imageId",
                    ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY mv.index, i."postId", i.index) rn
                  FROM "Image" i
                  JOIN "Post" p ON p.id = i."postId"
                  JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
                  JOIN "Model" m ON mv."modelId" = m.id AND m."userId" = p."userId"
                  WHERE m."id" = e."entityId"
                      AND i."ingestion" = 'Scanned'
                      AND i."needsReview" IS NULL
                  ) mi
                  WHERE mi.rn = 1
                )
        WHEN e."entityType" = 'ModelVersion'
            THEN  (
                SELECT mi."imageId" FROM (
                  SELECT
                    mv.id,
                    i.id as "imageId"
                  FROM "Image" i
                  JOIN "Post" p ON p.id = i."postId"
                  JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
                  WHERE mv."id" = e."entityId"
                      AND i."ingestion" = 'Scanned'
                      AND i."needsReview" IS NULL
                  ORDER BY mv.index, i."postId", i.index
                  ) mi
                  LIMIT 1
                )
        WHEN e."entityType" = 'Image'
            THEN e."entityId"
        ELSE (
            SELECT
                i.id
            FROM "Image" i
            JOIN "ImageConnection" ic ON ic."imageId" = i.id
              AND ic."entityType" = e."entityType"
              AND ic."entityId" = e."entityId"
            LIMIT 1
        )
        END as "imageId"
      FROM entities e
    )
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
      i."index",
      t."entityId",
      t."entityType"
    FROM targets t
    JOIN "Image" i ON i.id = t."imageId"`;

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined = [];
  if (include && include.includes('tags')) {
    const imageIds = images.map((i) => i.id);
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
  }

  return images.map((i) => ({
    ...i,
    tags: tagsVar?.filter((x) => x.imageId === i.id),
  }));
};

export const updateEntityImages = async ({
  tx,
  entityId,
  entityType,
  images,
  userId,
}: {
  tx?: Prisma.TransactionClient;
  entityId: number;
  entityType: string;
  images: ImageUploadProps[];
  userId: number;
}) => {
  const dbClient = tx ?? dbWrite;
  const connections = await dbClient.imageConnection.findMany({
    select: { imageId: true },
    where: {
      entityId,
      entityType,
    },
  });

  // Delete any images that are no longer in the list.
  await dbClient.imageConnection.deleteMany({
    where: {
      entityId,
      entityType,
      imageId: { notIn: images.map((i) => i.id).filter(isDefined) },
    },
  });

  const newImages = images.filter((x) => !x.id);
  const newLinkedImages = images.filter(
    (x) => !!x.id && !connections.find((c) => c.imageId === x.id)
  );

  const links = [...newLinkedImages.map((i) => i.id)];

  if (newImages.length > 0) {
    await dbClient.image.createMany({
      data: newImages.map((image) => ({
        ...image,
        meta: (image?.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
        userId,
        resources: undefined,
      })),
    });

    const imageRecords = await dbClient.image.findMany({
      select: { id: true, url: true, type: true, width: true, height: true },
      where: {
        url: { in: newImages.map((i) => i.url) },
        ingestion: ImageIngestionStatus.Pending,
        userId,
      },
    });

    links.push(...imageRecords.map((i) => i.id));

    // Process the new images just in case:
    const batches = chunk(imageRecords, 50);
    for (const batch of batches) {
      await Promise.all(batch.map((image) => ingestImage({ image, tx })));
    }
  }

  if (links.length > 0) {
    // Create any new files.
    await dbClient.imageConnection.createMany({
      data: links.filter(isDefined).map((id) => ({
        imageId: id,
        entityId,
        entityType,
      })),
    });
  }
};

type GetImageModerationReviewQueueRaw = {
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
  ingestion: ImageIngestionStatus;
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
  cursorId?: bigint;
  type: MediaType;
  metadata: Prisma.JsonValue;
  baseModel?: string;
  entityType: string;
  entityId: number;
  reportId?: number;
  reportReason?: string;
  reportStatus?: ReportStatus;
  reportDetails?: Prisma.JsonValue;
  reportUsername?: string;
  reportUserId?: number;
};
export const getImageModerationReviewQueue = async ({
  limit,
  cursor,
  needsReview,
  tagReview,
  reportReview,
  tagIds,
}: ImageReviewQueueInput) => {
  const AND: Prisma.Sql[] = [];

  if (needsReview) {
    AND.push(Prisma.sql`i."needsReview" = ${needsReview}`);
  }

  if (tagReview) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id AND toi."needsReview"
    )`);
  }

  if (tagIds?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImage" toi
      WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(tagIds)})
    )`);
  }

  // Order by oldest first. This is to ensure that images that have been in the queue the longest
  // are reviewed first.
  let orderBy = `i."id" DESC`;

  let cursorProp = 'i."id"';
  let cursorDirection = 'DESC';

  if (reportReview) {
    // Add this to the WHERE:
    AND.push(Prisma.sql`report."status" = 'Pending'`);
    // Also, update sorter to most recent:
    orderBy = `report."createdAt" ASC`;
    cursorProp = 'report.id';
    cursorDirection = 'ASC';
  }

  if (cursor) {
    // Random sort cursor is handled by the WITH query
    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    if (cursorProp)
      AND.push(Prisma.sql`${Prisma.raw(cursorProp)} ${Prisma.raw(cursorOperator)} ${cursor}`);
  }

  const reportsJoin = `
    JOIN "ImageReport" imgr ON i.id = imgr."imageId"
    JOIN "Report" report ON report.id = imgr."reportId"
    JOIN "User" ur ON ur.id = report."userId"
  `;

  const reportsSelect = `
    report.id as "reportId",
    report.reason as "reportReason",
    report.status as "reportStatus",
    report.details as "reportDetails",
    ur.username as "reportUsername",
    ur.id as "reportUserId",
  `;

  const rawImages = await dbRead.$queryRaw<GetImageModerationReviewQueueRaw[]>`
    -- Image moderation queue
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
      i.ingestion,
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
      ic."entityType",
      ic."entityId",
      ${Prisma.raw(reportReview ? reportsSelect : '')}
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
      FROM "Image" i
      JOIN "User" u ON u.id = i."userId"
      LEFT JOIN "Post" p ON p.id = i."postId"
      LEFT JOIN "ImageConnection" ic on ic."imageId" = i.id
      ${Prisma.raw(reportReview ? reportsJoin : '')}
      WHERE ${Prisma.join(AND, ' AND ')}
      ORDER BY ${Prisma.raw(orderBy)}
      LIMIT ${limit + 1}
  `;

  let nextCursor: bigint | undefined;

  if (rawImages.length > limit) {
    const nextItem = rawImages.pop();
    nextCursor = nextItem?.cursorId;
  }

  const imageIds = rawImages.map((i) => i.id);
  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined;

  if (tagReview) {
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
  }

  let namesMap: Map<number, string[]> | undefined;
  if (needsReview === 'poi' && imageIds.length > 0) {
    namesMap = new Map();
    const names = await dbRead.$queryRaw<{ imageId: number; name: string }[]>`
      SELECT
        toi."imageId",
        t.name
      FROM "TagsOnImage" toi
      JOIN "TagsOnTags" tot ON tot."toTagId" = toi."tagId"
      JOIN "Tag" t ON t.id = tot."toTagId"
      JOIN "Tag" f ON f.id = tot."fromTagId" AND f.name = 'real person'
      WHERE toi."imageId" IN (${Prisma.join(imageIds)});
    `;
    for (const x of names) {
      if (!namesMap.has(x.imageId)) namesMap.set(x.imageId, []);
      namesMap.get(x.imageId)?.push(x.name);
    }
  }

  const images: Array<
    Omit<ImageV2Model, 'stats' | 'metadata'> & {
      tags?: VotableTagModel[] | undefined;
      names?: string[];
      report?:
        | {
            id: number;
            reason: string;
            details: Prisma.JsonValue;
            status: ReportStatus;
            user: { id: number; username?: string | null };
          }
        | undefined;
      publishedAt?: Date | null;
      modelVersionId?: number | null;
      entityType?: string | null;
      entityId?: number | null;
      metadata?: MixedObject | null;
    }
  > = rawImages.map(
    ({
      userId: creatorId,
      username,
      userImage,
      deletedAt,
      reportId,
      reportReason,
      reportStatus,
      reportDetails,
      reportUsername,
      reportUserId,
      ...i
    }) => ({
      ...i,
      metadata: i.metadata as MixedObject,
      user: {
        id: creatorId,
        username,
        image: userImage,
        deletedAt,
        cosmetics: [],
        // No need for profile picture
        profilePicture: null,
      },
      reactions: [],
      tags: tagsVar?.filter((x) => x.imageId === i.id),
      names: namesMap?.get(i.id) ?? undefined,
      report: reportId
        ? {
            id: reportId,
            reason: reportReason as string,
            details: reportDetails as Prisma.JsonValue,
            status: reportStatus as ReportStatus,
            user: { id: reportUserId as number, username: reportUsername },
          }
        : undefined,
    })
  );

  return {
    nextCursor,
    items: images,
  };
};

export async function get404Images() {
  const imagesRaw = await dbRead.$queryRaw<{ url: string; username: string }[]>`
    SELECT
      u.username,
      i.url
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId" AND username IS NOT NULL
    JOIN "Collection" c ON c.id = ci."collectionId"
    WHERE c."userId" = -1
      AND c.name = '404 Contest'
      AND i."ingestion" = 'Scanned'
      AND i."needsReview" IS NULL
      AND i.nsfw = 'None'
      AND ci.status = 'ACCEPTED';
  `;

  const images = Object.values(imagesRaw).map((x) => [x.username, x.url] as [string, string]);
  return images;
}

type POITag = {
  id: number;
  name: string;
  count: number;
};
export async function getModeratorPOITags() {
  const tags = await dbRead.$queryRaw<POITag[]>`
    WITH real_person_tags AS MATERIALIZED (
      SELECT t.id, t.name
      FROM "TagsOnTags" tot
      JOIN "Tag" t ON t.id = tot."toTagId"
      JOIN "Tag" f ON f.id = tot."fromTagId"
      WHERE f.name = 'real person'
    )
    SELECT
      rpt.id,
      rpt.name,
      CAST(COUNT(i.id) as int) as count
    FROM "Image" i
    JOIN "TagsOnImage" toi ON toi."imageId" = i.id
    JOIN real_person_tags rpt ON rpt.id = toi."tagId"
    WHERE i."needsReview" = 'poi'
    GROUP BY rpt.id, rpt.name
    ORDER BY 3 DESC;
  `;

  return tags;
}

type NameReference = {
  imageId: number;
  tagId: number;
  name: string;
};
async function removeNameReference(images: number[]) {
  const tasks = chunk(images, 500).map((images) => async () => {
    // Get images to de-reference
    const [targets, prompts] = await Promise.all([
      await dbRead.$queryRaw<NameReference[]>`
        SELECT
          toi."imageId",
          t.id "tagId",
          t.name
        FROM "TagsOnImage" toi
        JOIN "TagsOnTags" tot ON tot."toTagId" = toi."tagId"
        JOIN "Tag" t ON t.id = tot."toTagId"
        JOIN "Tag" f ON f.id = tot."fromTagId" AND f.name = 'real person'
        WHERE toi."imageId" IN (${Prisma.join(images)});
      `,
      // Update prompts
      await dbRead.$queryRaw<{ imageId: number; prompt: string }[]>`
        SELECT
          i.id as "imageId",
          meta->>'prompt' as prompt
        FROM "Image" i
        WHERE id IN (${Prisma.join(images)});
      `,
    ]);
    const targetMap = new Map(targets.map((x) => [x.imageId, x]));

    // Update prompts
    for (const x of prompts) {
      const { name } = targetMap.get(x.imageId) ?? {};
      if (!name) continue;

      x.prompt = promptWordReplace(x.prompt, name, 'person');
    }

    const promptsJson = JSON.stringify(prompts);
    await dbWrite.$executeRaw`
      WITH updates AS (
        SELECT
          CAST(t->>'imageId' as int) as id,
          t->>'prompt' as prompt
        FROM json_array_elements(${promptsJson}::json) t
      )
      UPDATE "Image" i
        SET meta = jsonb_set(meta, '{prompt}', to_jsonb(t.prompt)),
          "needsReview" = null,
          ingestion = 'Scanned'::"ImageIngestionStatus"
      FROM updates t
      WHERE t.id = i.id;
    `;

    // Remove tags
    await dbWrite.$executeRaw`
      DELETE FROM "TagsOnImage" toi
      USING "TagsOnTags" tot
      WHERE toi."imageId" IN (${Prisma.join(images)})
        AND toi."tagId" = tot."toTagId"
        AND tot."fromTagId" IN (SELECT id FROM "Tag" WHERE name = 'real person');
    `;
  });

  await limitConcurrency(tasks, 3);
}
