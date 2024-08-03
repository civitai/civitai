import {
  Availability,
  CollectionMode,
  ImageGenerationProcess,
  ImageIngestionStatus,
  MediaType,
  MetricTimeframe,
  ModelType,
  Prisma,
  ReportReason,
  ReportStatus,
  ReviewReactions,
} from '@prisma/client';

import { TRPCError } from '@trpc/server';
import { chunk, truncate } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { VotableTagModel } from '~/libs/tags';
import { purgeCache } from '~/server/cloudflare/client';
import { CacheTTL, constants } from '~/server/common/constants';
import {
  BlockedReason,
  ImageScanType,
  ImageSort,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbRead } from '~/server/db/pgDb';
import { postMetrics } from '~/server/metrics';
import { leakingContentCounter } from '~/server/prom/client';
import { imagesForModelVersionsCache, tagIdsForImagesCache } from '~/server/redis/caches';
import { GetByIdInput, UserPreferencesInput, getByIdSchema } from '~/server/schema/base.schema';
import {
  AddOrRemoveImageTechniquesOutput,
  AddOrRemoveImageToolsOutput,
  CreateImageSchema,
  GetEntitiesCoverImage,
  GetInfiniteImagesOutput,
  ImageEntityType,
  imageMetaOutput,
  ImageRatingReviewOutput,
  ImageReviewQueueInput,
  ImageUploadProps,
  ReportCsamImagesInput,
  UpdateImageNsfwLevelOutput,
  UpdateImageTechniqueOutput,
  UpdateImageToolsOutput,
} from '~/server/schema/image.schema';
import { articlesSearchIndex, imagesSearchIndex } from '~/server/search-index';
import { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { ImageResourceHelperModel, imageSelect } from '~/server/selectors/image.selector';
import { ImageV2Model } from '~/server/selectors/imagev2.selector';
import { imageTagCompositeSelect, simpleTagSelect } from '~/server/selectors/tag.selector';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { bustCachesForPost, updatePostNsfwLevel } from '~/server/services/post.service';
import { bulkSetReportStatus } from '~/server/services/report.service';
import {
  getBlockedTags,
  getModeratedTags,
  getTagsNeedingReview,
} from '~/server/services/system-cache';
import { getVotableTags2 } from '~/server/services/tag.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getPeriods } from '~/server/utils/enum-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getCursor } from '~/server/utils/pagination-helpers';
import {
  onlySelectableLevels,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import { logToDb } from '~/utils/logging';
import { promptWordReplace } from '~/utils/metadata/audit';
import { removeEmpty } from '~/utils/object-helpers';
import { baseS3Client } from '~/utils/s3-client';
import { isDefined } from '~/utils/type-guards';
import {
  GetImageInput,
  ImageMetaProps,
  ImageModerationSchema,
  IngestImageInput,
  ingestImageSchema,
} from './../schema/image.schema';
import { collectionSelect } from '~/server/selectors/collection.selector';
import { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { redis } from '~/server/redis/client';
import { metricsClient } from '~/server/meilisearch/client';
import { logToAxiom } from '~/server/logging/client';
import dayjs, { ManipulateType } from 'dayjs';
import { simpleUserSelect } from '~/server/selectors/user.selector';
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

export async function purgeResizeCache({ url }: { url: string }) {
  const { items } = await baseS3Client.listObjects({
    bucket: env.S3_IMAGE_CACHE_BUCKET,
    prefix: url,
  });
  await baseS3Client.deleteManyObjects({
    bucket: env.S3_IMAGE_CACHE_BUCKET,
    keys: items.map((x) => x.Key).filter(isDefined),
  });
}

export const deleteImageById = async ({
  id,
  updatePost,
}: GetByIdInput & { updatePost?: boolean }) => {
  updatePost ??= true;
  try {
    const image = await dbWrite.image.delete({
      where: { id },
      select: { url: true, postId: true, nsfwLevel: true, userId: true },
    });
    if (!image) return;

    try {
      if (isProd && !(await imageUrlInUse({ url: image.url, id }))) {
        await baseS3Client.deleteObject({ bucket: env.S3_IMAGE_UPLOAD_BUCKET, key: image.url });
        await purgeResizeCache({ url: image.url });
      }
    } catch {
      // Ignore errors
    }

    await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
    // await dbWrite.$executeRaw`DELETE FROM "Image" WHERE id = ${id}`;
    if (updatePost && image.postId) {
      await updatePostNsfwLevel(image.postId);
      await bustCachesForPost(image.postId);
      postMetrics.queueUpdate(image.postId);
    }
    return image;
  } catch {
    // Ignore errors
  }
};

export const moderateImages = async ({
  ids,
  needsReview,
  reviewType,
  reviewAction,
}: ImageModerationSchema) => {
  if (reviewAction === 'delete') {
    const affected = await dbWrite.$queryRaw<{ id: number; userId: number; nsfwLevel: number }[]>`
      SELECT id, "userId", "nsfwLevel" FROM "Image"
      WHERE id IN (${Prisma.join(ids)});
    `;

    await dbWrite.image.updateMany({
      where: { id: { in: ids } },
      data: {
        needsReview: null,
        ingestion: 'Blocked',
        nsfwLevel: NsfwLevel.Blocked,
        blockedFor: BlockedReason.Moderated,
        updatedAt: new Date(),
      },
    });

    await imagesSearchIndex.queueUpdate(
      ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Delete }))
    );
    return affected;
  } else if (reviewAction === 'removeName') {
    removeNameReference(ids);
  } else if (reviewAction === 'mistake') {
    // Remove needsReview status
    await dbWrite.image.updateMany({
      where: { id: { in: ids } },
      data: { needsReview: null, ingestion: 'Scanned' },
    });
  } else {
    // Approve
    const results = await dbWrite.$queryRaw<{ id: number; nsfwLevel: number }[]>`
      UPDATE "Image" SET
        "needsReview" = ${needsReview},
        "ingestion" = 'Scanned',
        "nsfwLevel" = CASE
          WHEN "nsfwLevel" = ${NsfwLevel.Blocked}::int THEN 0
          ELSE "nsfwLevel"
        END
      WHERE id IN (${Prisma.join(ids)})
      RETURNING id, "nsfwLevel";
    `;

    // Remove tags that triggered review
    const tagIds = (await getTagsNeedingReview()).map((x) => x.id);

    // And moderated tags for POI review (since no NSFW allowed)
    const changeTags = reviewType === 'poi';
    if (changeTags) {
      const moderatedTags = await getModeratedTags();
      tagIds.push(...moderatedTags.map((x) => x.id));
    }

    // And blocked tags for Blocked Tag review
    const removeBlockedTags = reviewType === 'tag';
    if (removeBlockedTags) {
      const blockedTags = await getBlockedTags();
      tagIds.push(...blockedTags.map((x) => x.id));
    }

    await dbWrite.tagsOnImage.updateMany({
      where: { imageId: { in: ids }, tagId: { in: tagIds } },
      data: { disabled: true },
    });

    // Update nsfw level of image
    const resetLevels = results.filter((x) => x.nsfwLevel === 0).map((x) => x.id);
    if (resetLevels.length) await updateNsfwLevel(resetLevels);
    else if (changeTags) await updateNsfwLevel(ids);
  }
  return null;
};

export async function updateNsfwLevel(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  ids = [...new Set(ids)]; // dedupe
  if (!ids.length) return;
  await dbWrite.$executeRawUnsafe(`SELECT update_nsfw_levels(ARRAY[${ids.join(',')}]::integer[])`);
}

export const updateImageReportStatusByReason = ({
  id,
  reason,
  status,
}: {
  id: number;
  reason: ReportReason;
  status: ReportStatus;
}) => {
  return dbWrite.$queryRaw<{ id: number; userId: number }[]>`
    UPDATE "Report" r SET status = ${status}::"ReportStatus"
    FROM "ImageReport" i
    WHERE i."reportId" = r.id
      AND i."imageId" = ${id}
      AND r.reason = ${reason}::"ReportReason"
    RETURNING id, "userId"
  `;
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

export const getImageById = async ({ id }: GetByIdInput) => {
  return await dbRead.image.findUnique({
    where: { id },
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
      movieRatingModel: env.IMAGE_SCANNING_MODEL,
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

  if (!isProd || !callbackUrl) {
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
  name: string | null;
  url: string;
  nsfwLevel: NsfwLevel;
  width: number | null;
  height: number | null;
  hash: string | null;
  meta?: ImageMetaProps | null;
  hideMeta: boolean;
  hasMeta: boolean;
  onSite: boolean;
  generationProcess: ImageGenerationProcess | null;
  createdAt: Date;
  mimeType: string | null;
  scannedAt: Date | null;
  ingestion: ImageIngestionStatus;
  needsReview: string | null;
  userId: number;
  index: number | null;
  postId: number | null;
  postTitle: string | null;
  modelVersionId: number | null;
  imageId: number | null;
  publishedAt: Date | null;
  unpublishedAt?: Date | null;
  username: string | null;
  userImage: string | null;
  deletedAt: Date | null;
  cryCount: number;
  laughCount: number;
  likeCount: number;
  dislikeCount: number;
  heartCount: number;
  commentCount: number;
  collectedCount: number;
  tippedAmountCount: number;
  viewCount: number;
  cursorId?: string;
  type: MediaType;
  metadata: ImageMetadata | VideoMetadata | null;
  baseModel?: string;
  availability: Availability;
};
export type ImagesInfiniteModel = AsyncReturnType<typeof getAllImages>['items'][0];
export const getAllImages = async (
  input: GetInfiniteImagesOutput & {
    userId?: number;
    user?: SessionUser;
    headers?: Record<string, string>; // does this do anything?
  }
) => {
  const {
    limit,
    cursor,
    skip,
    postId,
    postIds,
    collectionId, // TODO - call this from separate method?
    modelId,
    modelVersionId,
    imageId, // TODO - remove, not in use
    username, // TODO - query by `userId` instead
    period,
    periodMode,
    tags,
    generation,
    reviewId, // TODO - remove, not in use
    prioritizedUserIds,
    include,
    excludeCrossPosts,
    reactions, // TODO - remove, not in use
    ids,
    includeBaseModel,
    types,
    hidden,
    followed,
    fromPlatform,
    user,
    pending,
    notPublished,
    tools,
    techniques,
    baseModels,
    collectionTagId,
    excludedUserIds,
  } = input;
  let { sort, browsingLevel } = input;

  const AND: Prisma.Sql[] = [Prisma.sql`i."postId" IS NOT NULL`];
  const WITH: Prisma.Sql[] = [];
  let orderBy: string;
  const cacheTags: string[] = [];
  let cacheTime = CacheTTL.xs;
  const userId = user?.id;
  const isModerator = user?.isModerator ?? false;
  const includeCosmetics = include?.includes('cosmetics'); // TODO: This must be done similar to user cosmetics.

  // TODO.fix remove test
  if (modelVersionId) {
    const shouldBypassSort = JSON.parse((await redis.get('bypassSort')) ?? '[]') as number[];
    if (shouldBypassSort.includes(modelVersionId)) sort = ImageSort.Newest;
  }

  // Exclude unselectable browsing levels
  browsingLevel = onlySelectableLevels(browsingLevel);

  // Filter to specific user content
  let targetUserId: number | undefined; // [x]
  if (username) {
    const targetUser = await dbRead.user.findUnique({ where: { username }, select: { id: true } });
    if (!targetUser) throw new Error('User not found');
    targetUserId = targetUser.id;
  }

  if (hidden) {
    if (!userId) throw throwAuthorizationError();
    const hiddenImages = await dbRead.imageEngagement.findMany({
      where: { userId, type: 'Hide' },
      select: { imageId: true },
    });
    const imageIds = hiddenImages.map((x) => x.imageId);
    if (imageIds.length) {
      cacheTime = 0;
      AND.push(Prisma.sql`i."id" IN (${Prisma.join(imageIds)})`);
    } else {
      return { items: [], nextCursor: undefined };
    }
  }

  // TODO.fix disable excludeCrossPosts
  // if (excludeCrossPosts && modelVersionId) {
  //   cacheTime = CacheTTL.day;
  //   cacheTags.push(`images-modelVersion:${modelVersionId}`);
  //   AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);
  // }

  // [x]
  if (ids && ids.length > 0) {
    AND.push(Prisma.sql`i."id" IN (${Prisma.join(ids)})`);
  }
  // [x]
  if (types && types.length > 0) {
    AND.push(Prisma.sql`i.type = ANY(ARRAY[${Prisma.join(types)}]::"MediaType"[])`);
  }

  // [x]
  if (include.includes('meta')) {
    AND.push(
      Prisma.sql`NOT (i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" = TRUE)`
    );
  }

  // [x]
  if (fromPlatform) {
    AND.push(Prisma.sql`(i.meta IS NOT NULL AND i.meta ? 'civitaiResources')`);
  }
  // [x]
  if (notPublished && isModerator) {
    AND.push(Prisma.sql`(p."publishedAt" IS NULL)`);
  }

  let from = 'FROM "Image" i';
  const joins: string[] = [];
  // Filter to specific model/review content
  const prioritizeUser = !!prioritizedUserIds?.length; // [x]
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

  // [x]
  if (targetUserId) {
    WITH.push(
      Prisma.sql`collaboratingPosts AS (
        SELECT "entityId" id FROM "EntityCollaborator"
        WHERE "userId" = ${targetUserId}
          AND "entityType" = 'Post'
          AND "status" = 'Approved'
        )`
    );

    AND.push(
      // TOOD: Due to performance reasons we cannot add this here yet. Will need to revise with other teams.
      // Prisma.sql`(u."id" = ${targetUserId} OR i."postId" IN (SELECT id FROM collaboratingPosts))`
      Prisma.sql`u."id" = ${targetUserId}`
    );
    // Don't cache self queries
    cacheTime = 0;
    // if (targetUserId !== userId) {
    //   cacheTime = CacheTTL.day;
    //   cacheTags.push(`images-user:${targetUserId}`);
    // } else cacheTime = 0;
  }

  // Filter only followed users
  // [x]
  if (userId && followed) {
    const followedUsers = await dbRead.userEngagement.findMany({
      where: { userId, type: 'Follow' },
      select: { targetUserId: true },
    });
    const userIds = followedUsers.map((x) => x.targetUserId);
    if (userIds.length) {
      cacheTime = 0;
      AND.push(Prisma.sql`i."userId" IN (${Prisma.join(userIds)})`);
    }
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
  // [x]
  if (generation?.length) {
    AND.push(Prisma.sql`i."generationProcess" IN (${Prisma.join(generation)})`);
  }

  // Filter to a specific post
  // [x]
  if (postId) AND.push(Prisma.sql`i."postId" = ${postId}`);
  // [x]
  if (!!postIds?.length) AND.push(Prisma.sql`i."postId" IN (${Prisma.join(postIds)})`);

  // Filter to a specific image
  // [x] not needed
  if (imageId) AND.push(Prisma.sql`i.id = ${imageId}`);

  if (sort === ImageSort.Random && !collectionId) {
    throw throwBadRequestError('Random sort requires a collectionId');
  }

  if (collectionTagId && !collectionId) {
    throw throwBadRequestError('collectionTagId requires a collectionId');
  }

  // Filter to a specific collection and relevant status:
  if (collectionId) {
    const permissions = await getUserCollectionPermissionsById({
      userId,
      isModerator,
      id: collectionId,
    });

    // Check if user has access to collection
    if (!permissions.read) return { nextCursor: undefined, items: [] };

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
              ${collectionTagId ? ` AND ci."tagId" = ${collectionTagId}` : ``}
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
            ${Prisma.raw(collectionTagId ? ` AND ci."tagId" = ${collectionTagId}` : ``)}
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

  if (excludedUserIds?.length) {
    AND.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
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
    }
    // else if (sort === ImageSort.MostTipped) {
    //   orderBy = `im."tippedAmountCount" DESC, im."reactionCount" DESC, im."imageId"`;
    //   if (!isGallery) AND.push(Prisma.sql`im."tippedAmountCount" > 0`);
    // }
    else if (sort === ImageSort.Random) orderBy = 'ct."randomId" DESC';
    else if (sort === ImageSort.Oldest) orderBy = `i."createdAt" ASC`;
    else {
      if (from.indexOf(`irr`) !== -1) {
        // Ensure to sort by irr.imageId when reading from imageResources to maximize index utilization
        orderBy = `irr."imageId" DESC`;
      } else {
        orderBy = `i."id" DESC`;
      }
    }
  }

  // if (hidden) {
  //   cacheTime = 0;
  //   AND.push(Prisma.sql`i."id" IN (${Prisma.join(excludedImageIds ?? [])})`);
  // }

  // Limit to images created since period start
  const sortingByMetrics = orderBy.includes('im.'); // [x]
  if (sortingByMetrics && period !== 'AllTime' && periodMode !== 'stats') {
    const ageGroups = getPeriods(period);
    AND.push(
      Prisma.sql`im."ageGroup" = ANY(ARRAY[${Prisma.join(ageGroups)}]::"MetricTimeframe"[])`
    );
  } else if (period && period !== 'AllTime' && periodMode !== 'stats') {
    const interval = period.toLowerCase();
    AND.push(
      Prisma.sql`i."createdAt" >= date_trunc('day', now()) - interval '1 ${Prisma.raw(interval)}'`
    );
  }

  // Handle cursor & skip conflict
  if (cursor && skip) throw new Error('Cannot use skip with cursor'); // [x]

  // Handle cursor prop
  let { where: cursorClause, prop: cursorProp } = getCursor(orderBy, cursor);
  if (sort === ImageSort.Random) {
    cursorProp = 'i."id"';
    cursorClause = undefined;
  }
  if (cursorClause) AND.push(cursorClause);

  if (prioritizeUser) {
    // [x]
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

  if (!!tools?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "ImageTool" it
      WHERE it."imageId" = i.id AND it."toolId" IN (${Prisma.join(tools)})
    )`);
  }
  if (!!techniques?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "ImageTechnique" it
      WHERE it."imageId" = i.id AND it."techniqueId" IN (${Prisma.join(techniques)})
    )`);
  }

  if (baseModels?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      RIGHT JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" = mv.id
      WHERE mv."baseModel" IN (${Prisma.join(baseModels)})
    )`);
  }

  if (pending && (isModerator || userId)) {
    if (isModerator) {
      AND.push(Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)`);
    } else if (userId) {
      AND.push(Prisma.sql`(i."needsReview" IS NULL OR i."userId" = ${userId})`);
      AND.push(
        Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR (i."nsfwLevel" = 0 AND i."userId" = ${userId}))`
      );
    }
  } else {
    AND.push(Prisma.sql`i."needsReview" IS NULL`);
    AND.push(
      browsingLevel
        ? Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0 AND i."nsfwLevel" != 0`
        : Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );
  }

  // TODO.metricSearch add missing props
  // getImagesFromSearch({
  //   modelVersionId,
  //   types,
  //   browsingLevel,
  //   fromPlatform,
  //   hasMeta: include.includes('meta'),
  //   baseModels,
  //   period,
  //   sort,
  // }).catch();

  // TODO: Adjust ImageMetric
  const queryFrom = Prisma.sql`
    ${Prisma.raw(from)}
    ${Prisma.raw(joins.join('\n'))}
    JOIN "User" u ON u.id = i."userId"
    JOIN "Post" p ON p.id = i."postId"
    ${Prisma.raw(WITH.length && collectionId ? `JOIN ct ON ct."imageId" = i.id` : '')}
    JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'::"MetricTimeframe"
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;
  const query = Prisma.sql`
    ${queryWith}
    SELECT
      i.id,
      i.name,
      i.url,
      i."nsfwLevel",
      i.width,
      i.height,
      i.hash,
      -- i.meta,
      i."hideMeta",
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta->>'civitaiResources' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) as "onSite",
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
      p.metadata->>'unpublishedAt' "unpublishedAt",
      p."modelVersionId",
      u.username,
      u.image "userImage",
      u."deletedAt",
      p."availability",
      ${Prisma.raw(include.includes('meta') ? 'i.meta,' : '')}
      ${Prisma.raw(
        includeBaseModel
          ? `(
            SELECT mv."baseModel"
            FROM "ImageResource" ir
            LEFT JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
            LEFT JOIN "Model" m ON mv."modelId" = m.id
            WHERE m."type" = 'Checkpoint' AND ir."imageId" = i.id
            LIMIT 1
          ) "baseModel",`
          : ''
      )}
      im."cryCount",
      im."laughCount",
      im."likeCount",
      im."dislikeCount",
      im."heartCount",
      im."commentCount",
      im."collectedCount",
      im."tippedAmountCount",
      im."viewCount",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
      ${queryFrom}
      ORDER BY ${Prisma.raw(orderBy)}
      ${Prisma.raw(skip ? `OFFSET ${skip}` : '')}
      LIMIT ${limit + 1}
  `;

  // Disable Prisma query
  // if (!env.IMAGE_QUERY_CACHING) cacheTime = 0;
  // const cacheable = queryCache(dbRead, 'getAllImages', 'v1');
  // const rawImages = await cacheable<GetAllImagesRaw[]>(query, { ttl: cacheTime, tag: cacheTags });

  const { rows: rawImages } = await pgDbRead.query<GetAllImagesRaw>(query);
  // const rawImages = await dbRead.$queryRaw<GetAllImagesRaw[]>(query);

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

  let nextCursor: string | undefined;
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
        tagNsfwLevel: true,
        score: true,
        automated: true,
        upVotes: true,
        downVotes: true,
        needsReview: true,
      },
    });

    tagsVar = rawTags.map(({ tagId, tagName, tagType, tagNsfwLevel, ...tag }) => ({
      ...tag,
      id: tagId,
      type: tagType,
      nsfwLevel: tagNsfwLevel as NsfwLevel,
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

  const userIds = rawImages.map((i) => i.userId);
  const [userCosmetics, profilePictures, cosmetics] = await Promise.all([
    includeCosmetics ? await getCosmeticsForUsers(userIds) : undefined,
    include?.includes('profilePictures') ? await getProfilePicturesForUsers(userIds) : undefined,
    includeCosmetics ? await getCosmeticsForEntity({ ids: imageIds, entity: 'Image' }) : undefined,
  ]);

  const now = new Date();
  const images: Array<
    Omit<ImageV2Model, 'nsfwLevel' | 'metadata'> & {
      // meta: ImageMetaProps | null; // TODO - don't fetch meta
      meta?: ImageMetaProps | null; // deprecated. Only used in v1 api endpoint
      hideMeta: boolean; // TODO - remove references to this. Instead, use `hasMeta`
      hasMeta: boolean;
      tags?: VotableTagModel[] | undefined;
      tagIds?: number[];
      publishedAt?: Date | null;
      modelVersionId?: number | null;
      baseModel?: string | null; // TODO - remove
      availability?: Availability;
      nsfwLevel: NsfwLevel;
      cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
      metadata: ImageMetadata | VideoMetadata | null;
      onSite: boolean;
    }
  > = rawImages
    .filter((x) => {
      if (isModerator) return true;
      // if (x.needsReview && x.userId !== userId) return false;
      if ((!x.publishedAt || x.publishedAt > now || !!x.unpublishedAt) && x.userId !== userId)
        return false;
      // if (x.ingestion !== 'Scanned' && x.userId !== userId) return false;
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
        collectedCount,
        tippedAmountCount,
        viewCount,
        cursorId,
        unpublishedAt,
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
          collectedCountAllTime: collectedCount,
          tippedAmountCountAllTime: tippedAmountCount,
          viewCountAllTime: viewCount,
        },
        reactions:
          userReactions?.[i.id]?.map((r) => ({ userId: userId as number, reaction: r })) ?? [],
        tags: tagsVar?.filter((x) => x.imageId === i.id),
        tagIds: tagIdsVar?.[i.id]?.tags,
        cosmetic: cosmetics?.[i.id] ?? null,
      })
    );

  return {
    nextCursor,
    items: images,
  };
};

const METRICS_SEARCH_INDEX = 'metrics_images_v1_NEW';
type ImageSearchInput = {
  modelVersionId?: number;
  types?: MediaType[];
  hasMeta?: boolean;
  fromPlatform?: boolean;
  notPublished?: boolean;
  baseModels?: string[];
  period?: MetricTimeframe;
  browsingLevel?: NsfwLevel;
  sort?: ImageSort;
  limit?: number;
  page?: number;
  offset?: number;
  // Unsupported
  tags?: number[];
  techniques?: number[];
  tools?: number[];
  userIds?: number | number[];
  modelId?: number;
  reviewId?: number;
  excludeUserIds?: number[];
  currentUserId?: number;
  isModerator?: boolean;
};
function strArray(arr: any[]) {
  return arr.map((x) => `'${x}'`).join(',');
}
async function getImagesFromSearch(input: ImageSearchInput) {
  if (!metricsClient) return [];

  const {
    sort,
    modelVersionId,
    types,
    hasMeta,
    fromPlatform,
    notPublished,
    userIds,
    reviewId,
    modelId,
    tags,
    tools,
    techniques,
    baseModels,
    excludeUserIds,
    period,
    currentUserId,
    isModerator,
  } = input;
  let { browsingLevel } = input;

  // TODO.metricSearch remove hash, cosmetic
  // TODO.metricSearch if reviewId, get corresponding userId instead and add to userIds before making this request

  // Filter
  //------------------------
  const filters: string[] = [];

  // NSFW Level
  if (!browsingLevel) browsingLevel = NsfwLevel.PG;
  else browsingLevel = onlySelectableLevels(browsingLevel);
  const browsingLevels = Flags.instanceToArray(browsingLevel);
  if (isModerator) browsingLevels.push(0);
  filters.push(`nsfwLevel IN [${browsingLevels.join(',')}]`);
  // TODO.metricSearch test adding OR (nsfwLevel IN [0] AND userId = ${currentUserId}) to above with () around it

  if (modelVersionId) filters.push(`modelVersionIds IN [${modelVersionId}]`);
  if (types && types.length) filters.push(`mediaType IN [${types.join(',')}]`);
  if (hasMeta) filters.push(`hasMeta = true`);
  if (fromPlatform) filters.push(`madeOnSite = true`);

  // TODO.metricSearch add userId
  // if (userIds) {
  //   userIds = Array.isArray(userIds) ? userIds : [userIds];
  //   filters.push(`userId IN [${userIds.join(',')}]`)
  // }

  // TODO.metricSearch add published filter
  // if (notPublished && isModerator) filters.push(`published = false`);

  // TODO.metricSearch replace tags with tagIds
  // if (tags && tags.length) filters.push(`tagIds IN [${tags.join(',')}]`);

  // TODO.metricSearch add tools by id
  // if (!!tools?.length) filters.push(`toolIds IN [${tools.join(',')}]`);

  // TODO.metricSearch add techniques by id
  // if (!!techniques?.length) filters.push(`techniqueIds IN [${techniques.join(',')}]`);

  if (baseModels?.length) filters.push(`baseModel IN [${strArray(baseModels)}]`);

  // Handle period filter
  let afterDate: Date | undefined;
  if (period && period !== 'AllTime') {
    const now = dayjs();
    afterDate = now.subtract(1, period.toLowerCase() as ManipulateType).toDate();
  }
  if (afterDate) filters.push(`sortAtUnix > ${afterDate.getTime()}`);

  // Log properties we don't support yet
  const cantProcess: Record<string, any> = {
    reviewId,
    modelId,
    userIds,
    notPublished,
    tags,
    tools,
    techniques,
    excludeUserIds,
  };
  if (input.reviewId || input.modelId) {
    const missingKeys = Object.keys(cantProcess).filter((key) => cantProcess[key] !== undefined);
    logToAxiom({ type: 'cant-use-search', input: JSON.stringify(missingKeys) }, 'temp-search');
  }

  // Sort
  //------------------------
  let searchSort = 'sortAt:desc';
  if (sort === ImageSort.MostComments) searchSort = 'commentCount:desc';
  else if (sort === ImageSort.MostReactions) searchSort = 'reactionCount:desc';
  else if (sort === ImageSort.MostCollected) searchSort = 'collectedCount:desc';
  else if (sort === ImageSort.Oldest) searchSort = 'sortAt:asc';

  const request = {
    filter: filters.join(' AND '),
    sort: [searchSort],
    limit: input.limit ?? 100,
    offset: input.offset,
    page: input.page,
  };

  try {
    const results = await metricsClient.index(METRICS_SEARCH_INDEX).search(null, request);

    const metrics = {
      hits: results.hits.length,
      total: results.estimatedTotalHits,
      processingTimeMs: results.processingTimeMs,
    };
    logToAxiom(
      { type: 'search-result', metrics, input: removeEmpty(input), request },
      'temp-search'
    );

    return results.hits;
  } catch (error) {
    const err = error as Error;
    logToAxiom(
      {
        type: 'search-error',
        error: err.message,
        cause: err.cause,
        input: removeEmpty(input),
        request,
      },
      'temp-search'
    );
    return [];
  }
}

export async function getTagIdsForImages(imageIds: number[]) {
  return await tagIdsForImagesCache.fetch(imageIds);
}
export async function clearImageTagIdsCache(imageId: number | number[]) {
  await tagIdsForImagesCache.bust(imageId);
}
export async function updateImageTagIdsForImages(imageId: number | number[]) {
  await tagIdsForImagesCache.refresh(imageId);
}

export async function getTagNamesForImages(imageIds: number[]) {
  const imageTagsArr = await dbRead.$queryRaw<{ imageId: number; tag: string }[]>`
    SELECT "imageId", t.name as tag
    FROM "TagsOnImage" toi
    JOIN "Tag" t ON t.id = toi."tagId"
    WHERE "imageId" IN (${Prisma.join(imageIds)})
  `;
  const imageTags = imageTagsArr.reduce((acc, { imageId, tag }) => {
    if (!acc[imageId]) acc[imageId] = [];
    acc[imageId].push(tag);
    return acc;
  }, {} as Record<number, string[]>);
  return imageTags;
}

export async function getResourceIdsForImages(imageIds: number[]) {
  const imageResourcesArr = await dbRead.$queryRaw<{ imageId: number; modelVersionId: number }[]>`
    SELECT "imageId", "modelVersionId"
    FROM "ImageResource"
    WHERE "imageId" IN (${Prisma.join(imageIds)})
      AND "modelVersionId" IS NOT NULL
  `;
  const imageResources = imageResourcesArr.reduce((acc, { imageId, modelVersionId }) => {
    if (!acc[imageId]) acc[imageId] = [];
    acc[imageId].push(modelVersionId);
    return acc;
  }, {} as Record<number, number[]>);
  return imageResources;
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
      i.height,
      i.width,
      i.index,
      i.hash,
      -- i.meta,
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
      i."nsfwLevel",
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta->>'civitaiResources' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) as "onSite",
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
      ${
        !withoutPost
          ? Prisma.sql`
            p."availability" "availability",
            p."publishedAt" "publishedAt",
          `
          : Prisma.sql`'Public' "availability",`
      }
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
      irh."modelThumbsUpCount",
      irh."modelThumbsDownCount",
      irh."modelDownloadCount",
      irh."modelCommentCount",
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

export type ImagesForModelVersions = {
  id: number;
  userId: number;
  name: string;
  url: string;
  nsfwLevel: NsfwLevel;
  width: number;
  height: number;
  hash: string;
  modelVersionId: number;
  // meta: ImageMetaProps | null;
  type: MediaType;
  metadata: Prisma.JsonValue;
  tags?: number[];
  availability: Availability;
  sizeKB?: number;
  onSite: boolean;
  hasMeta: boolean;
};

export const getImagesForModelVersion = async ({
  modelVersionIds,
  excludedTagIds,
  excludedIds,
  excludedUserIds,
  imagesPerVersion = 1,
  include = [],
  user,
  pending,
  browsingLevel,
}: {
  modelVersionIds: number | number[];
  excludedTagIds?: number[];
  excludedIds?: number[];
  excludedUserIds?: number[];
  imagesPerVersion?: number;
  include?: Array<'meta' | 'tags'>;
  user?: SessionUser;
  pending?: boolean;
  browsingLevel?: number;
}) => {
  if (!Array.isArray(modelVersionIds)) modelVersionIds = [modelVersionIds];
  if (!modelVersionIds.length) return [] as ImagesForModelVersions[];

  const userId = user?.id;
  const isModerator = user?.isModerator ?? false;

  const imageWhere: Prisma.Sql[] = [Prisma.sql`p."publishedAt" IS NOT NULL`];

  if (!!excludedTagIds?.length) {
    const excludedTagsOr: Prisma.Sql[] = [
      Prisma.join(
        [
          Prisma.sql`i."nsfwLevel" != 0`,
          Prisma.sql`NOT EXISTS (SELECT 1 FROM "TagsOnImage" toi WHERE toi."imageId" = i.id AND toi.disabled = false AND toi."tagId" IN (${Prisma.join(
            excludedTagIds
          )}) )`,
        ],
        ' AND '
      ),
    ];
    if (userId) excludedTagsOr.push(Prisma.sql`i."userId" = ${userId}`);
    imageWhere.push(Prisma.sql`(${Prisma.join(excludedTagsOr, ' OR ')})`);
  }
  if (!!excludedIds?.length) {
    imageWhere.push(Prisma.sql`i.id NOT IN (${Prisma.join(excludedIds)})`);
  }
  if (!!excludedUserIds?.length) {
    imageWhere.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
  }

  if (browsingLevel) browsingLevel = onlySelectableLevels(browsingLevel);
  if (pending && (isModerator || userId) && browsingLevel) {
    if (isModerator) {
      imageWhere.push(Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)`);
    } else if (userId) {
      imageWhere.push(Prisma.sql`(i."needsReview" IS NULL OR i."userId" = ${userId})`);
      imageWhere.push(
        Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR (i."nsfwLevel" = 0 AND i."userId" = ${userId}))`
      );
    }
  } else {
    imageWhere.push(Prisma.sql`i."needsReview" IS NULL`);
    imageWhere.push(
      browsingLevel
        ? Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0`
        : Prisma.sql`i."nsfwLevel" != 0`
    );
  }

  const query = Prisma.sql`
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
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE (p."userId" = m."userId" OR m."userId" = -1)
          AND p."modelVersionId" IN (${Prisma.join(modelVersionIds)})
          AND ${Prisma.join(imageWhere, ' AND ')}

      ) ranked
      WHERE ranked.row_num <= ${imagesPerVersion}
    )
    SELECT
      i.id,
      i."userId",
      i.name,
      i.url,
      i."nsfwLevel",
      i.width,
      i.height,
      i.hash,
      i.type,
      i.metadata,
      t."modelVersionId",
      ${Prisma.raw(include.includes('meta') ? 'i.meta,' : '')}
      p."availability",
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta->>'civitaiResources' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) as "onSite"
    FROM targets t
    JOIN "Image" i ON i.id = t.id
    JOIN "Post" p ON p.id = i."postId"
    ORDER BY i."postId", i."index"
  `;
  const images = await dbRead.$queryRaw<ImagesForModelVersions[]>(query);

  const remainingModelVersionIds = modelVersionIds.filter(
    (x) => !images.some((i) => i.modelVersionId === x)
  );

  // if (remainingModelVersionIds.length) {
  //   const communityImages = await dbRead.$queryRaw<ImagesForModelVersions[]>`
  //       -- Get Community posts tied to the specific modelVersion via the post.
  //       WITH targets AS (
  //         SELECT
  //           id,
  //           "modelVersionId",
  //           row_num
  //         FROM (
  //           SELECT
  //             i.id,
  //             p."modelVersionId",
  //             row_number() OVER (PARTITION BY p."modelVersionId" ORDER BY im."reactionCount" DESC) row_num
  //           FROM "Image" i
  //           JOIN "Post" p ON p.id = i."postId"
  //           JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'::"MetricTimeframe"
  //           WHERE p."modelVersionId" IN (${Prisma.join(remainingModelVersionIds)})
  //             AND ${Prisma.join(imageWhere, ' AND ')}
  //         ) ranked
  //         WHERE ranked.row_num <= 20
  //       )
  //       SELECT
  //         i.id,
  //         i."userId",
  //         i.name,
  //         i.url,
  //         i."nsfwLevel",
  //         i.width,
  //         i.height,
  //         i.hash,
  //         i.type,
  //         i.metadata,
  //         t."modelVersionId",
  //         p."availability"
  //         ${Prisma.raw(include.includes('meta') ? ', i.meta' : '')}
  //       FROM targets t
  //       JOIN "Image" i ON i.id = t.id
  //       JOIN "Post" p ON p.id = i."postId"
  //       ORDER BY t.row_num
  //     `;
  //   images = [...images, ...communityImages];
  // }

  if (include.includes('tags')) {
    const imageIds = images.map((i) => i.id);
    const tagIdsVar = await getTagIdsForImages(imageIds);
    for (const image of images) {
      image.tags = tagIdsVar?.[image.id]?.tags;
    }
  }

  return images;
};

export async function getImagesForModelVersionCache(modelVersionIds: number[]) {
  const images = await imagesForModelVersionsCache.fetch(modelVersionIds);
  const tagsForImages = await tagIdsForImagesCache.fetch(Object.keys(images).map(Number));
  return Object.keys(images).reduce(
    (acc, imageId) => ({
      ...acc,
      [imageId]: {
        ...images[imageId],
        tags: tagsForImages[imageId]?.tags,
      },
    }),
    images
  );
}
export async function deleteImagesForModelVersionCache(modelVersionId: number) {
  await imagesForModelVersionsCache.bust(modelVersionId);
}

export const getImagesForPosts = async ({
  postIds,
  excludedIds,
  user,
  coverOnly = true,
  browsingLevel,
  pending,
}: {
  postIds: number | number[];
  excludedIds?: number[];
  coverOnly?: boolean;
  browsingLevel?: number;
  user?: SessionUser;
  pending?: boolean;
}) => {
  const userId = user?.id;
  const isModerator = user?.isModerator ?? false;

  if (!Array.isArray(postIds)) postIds = [postIds];
  const imageWhere: Prisma.Sql[] = [
    Prisma.sql`i."postId" IN (${Prisma.join(postIds)})`,
    Prisma.sql`i."needsReview" IS NULL`,
  ];

  //   if (!!excludedIds?.length)
  //     imageWhere.push(Prisma.sql`i."id" NOT IN (${Prisma.join(excludedIds)})`);
  // }

  if (browsingLevel) browsingLevel = onlySelectableLevels(browsingLevel);
  if (pending && (isModerator || userId) && browsingLevel) {
    if (isModerator) {
      imageWhere.push(Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)`);
    } else if (userId) {
      imageWhere.push(Prisma.sql`(i."needsReview" IS NULL OR i."userId" = ${userId})`);
      imageWhere.push(
        Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR (i."nsfwLevel" = 0 AND i."userId" = ${userId}))`
      );
    }
  } else {
    imageWhere.push(Prisma.sql`i."needsReview" IS NULL`);
    imageWhere.push(
      browsingLevel
        ? Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0`
        : Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );
  }

  const images = await dbRead.$queryRaw<
    {
      id: number;
      userId: number;
      name: string;
      url: string;
      nsfwLevel: NsfwLevel;
      width: number;
      height: number;
      hash: string;
      createdAt: Date;
      generationProcess: ImageGenerationProcess | null;
      postId: number;
      cryCount: number;
      laughCount: number;
      likeCount: number;
      dislikeCount: number;
      heartCount: number;
      commentCount: number;
      tippedAmountCount: number;
      type: MediaType;
      metadata: ImageMetadata | VideoMetadata | null;
      reactions?: ReviewReactions[];
      hasMeta: boolean;
      onSite: boolean;
    }[]
  >`
    SELECT
      i.id,
      i."userId",
      i.name,
      i.url,
      i."nsfwLevel",
      i.width,
      i.height,
      i.hash,
      i.type,
      i.metadata,
      i."createdAt",
      i."generationProcess",
      i."postId",
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta->>'civitaiResources' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) as "onSite",
      ${Prisma.raw(`
        jsonb_build_object(
          'prompt', i.meta->>'prompt',
          'negativePrompt', i.meta->>'negativePrompt',
          'cfgScale', i.meta->>'cfgScale',
          'steps', i.meta->>'steps',
          'sampler', i.meta->>'sampler',
          'seed', i.meta->>'seed',
          'hashes', i.meta->>'hashes',
          'clipSkip', i.meta->>'clipSkip',
          'Clip skip', i.meta->>'Clip skip'
        ) as "meta",
      `)}
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
    FROM "Image" i
    LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = 'AllTime'
    WHERE ${Prisma.join(imageWhere, ' AND ')}
    ORDER BY i.index ASC
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
    tagIds: rawTags.filter((t) => t.imageId === i.id).map((t) => t.tagId),
    reactions: userId ? reactions?.map((r) => ({ userId, reaction: r })) ?? [] : [],
  }));
};

export const removeImageResource = async ({ id }: GetByIdInput) => {
  try {
    const resource = await dbWrite.imageResource.delete({
      where: { id },
    });
    if (!resource) throw throwNotFoundError(`No image resource with id ${id}`);

    purgeImageGenerationDataCache(id);
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
      ({ tagId, tagName, tagType, tagNsfwLevel, ...tag }) => ({
        ...tag,
        id: tagId,
        type: tagType,
        nsfwLevel: tagNsfwLevel as NsfwLevel,
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
  nsfwLevel: NsfwLevel;
  width: number;
  height: number;
  hash: string;
  meta: ImageMetaProps; // TODO - remove
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
  metadata: ImageMetadata | VideoMetadata;
  entityId: number;
  hasMeta: boolean;
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
      i."nsfwLevel",
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
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
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
        tagNsfwLevel: true,
        score: true,
        automated: true,
        upVotes: true,
        downVotes: true,
        needsReview: true,
      },
    });

    tagsVar = rawTags.map(({ tagId, tagName, tagType, tagNsfwLevel, ...tag }) => ({
      ...tag,
      id: tagId,
      type: tagType,
      nsfwLevel: tagNsfwLevel as NsfwLevel,
      name: tagName,
    }));
  }

  return images.map((i) => ({
    ...i,
    tags: tagsVar?.filter((x) => x.imageId === i.id),
  }));
};

function parseImageCreateData({
  entityType,
  entityId,

  ...image
}: CreateImageSchema & { userId: number }) {
  const data = {
    ...image,
    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
    generationProcess: image.meta
      ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
      : null,
  };
  switch (entityType) {
    case 'Post':
      return { postId: entityId, ...data };
    default:
      return data;
  }
}

export async function createImage({
  entityType,
  entityId,
  ...image
}: CreateImageSchema & { userId: number }) {
  const data = parseImageCreateData({ entityType, entityId, ...image });
  const result = await dbWrite.image.create({ data, select: { id: true } });

  await ingestImage({
    image: {
      id: result.id,
      url: image.url,
      type: image.type,
      height: image.height,
      width: image.width,
    },
  });

  return result;
}

// TODO - remove this after all article cover images are ingested
export async function createArticleCoverImage({
  entityType,
  entityId,
  ...image
}: CreateImageSchema & { userId: number }) {
  const data = parseImageCreateData({ entityType, entityId, ...image });
  const result = await dbWrite.image.create({ data, select: { id: true } });

  return await dbWrite.article.update({
    where: { id: entityId },
    data: { coverId: result.id },
    select: { id: true },
  });
}

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
  nsfwLevel: NsfwLevel;
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
  postId: number | null;
  type: MediaType;
  metadata: MixedObject | null;
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
  // Models, Images, Bounties, BountyEntries, Article and Post.
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
                    AND m.status = 'Published'
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
                    AND mv.status = 'Published'
                    AND i."ingestion" = 'Scanned'
                    AND i."needsReview" IS NULL
                  ORDER BY mv.index, i."postId", i.index
                  ) mi
                  LIMIT 1
                )
        WHEN e."entityType" = 'Image'
          THEN (
            SELECT i.id FROM "Image" i
            WHERE i.id = e."entityId"
              AND i."ingestion" = 'Scanned'
              AND i."needsReview" IS NULL
          )
        WHEN e."entityType" = 'Article'
          THEN (
            SELECT ai."imageId" FROM (
              SELECT
                a.id,
                i.id as "imageId"
              FROM "Image" i
              JOIN "Article" a ON a."coverId" = i.id
              WHERE a."id" = e."entityId"
                AND a."publishedAt" IS NOT NULL
                AND i."ingestion" = 'Scanned'
                AND i."needsReview" IS NULL
            ) ai
            LIMIT 1
          )
        WHEN e."entityType" = 'Post'
          THEN (
            SELECT pi."imageId" FROM (
              SELECT
                p.id,
                i.id as "imageId"
              FROM "Image" i
              JOIN "Post" p ON p.id = i."postId"
              WHERE p."id" = e."entityId"
                AND p."publishedAt" IS NOT NULL
                AND i."ingestion" = 'Scanned'
                AND i."needsReview" IS NULL
              ORDER BY i."postId", i.index
            ) pi
            LIMIT 1
          )
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
      i."nsfwLevel",
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
      i."postId",
      t."entityId",
      t."entityType"
    FROM targets t
    JOIN "Image" i ON i.id = t."imageId"
    WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL`;

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
        tagNsfwLevel: true,
        score: true,
        automated: true,
        upVotes: true,
        downVotes: true,
        needsReview: true,
      },
    });

    tagsVar = rawTags.map(({ tagId, tagName, tagType, tagNsfwLevel, ...tag }) => ({
      ...tag,
      id: tagId,
      type: tagType,
      nsfwLevel: tagNsfwLevel as NsfwLevel,
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
  nsfwLevel: NsfwLevel;
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
  reportCount?: number;
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
    array_length("alsoReportedBy", 1) as "reportCount",
    ur.username as "reportUsername",
    ur.id as "reportUserId",
  `;

  const rawImages = await dbRead.$queryRaw<GetImageModerationReviewQueueRaw[]>`
    -- Image moderation queue
    SELECT
      i.id,
      i.name,
      i.url,
      i."nsfwLevel",
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

  if (tagReview || needsReview === 'tag') {
    const rawTags = await dbRead.imageTag.findMany({
      where: { imageId: { in: imageIds } },
      select: {
        imageId: true,
        tagId: true,
        tagName: true,
        tagType: true,
        tagNsfwLevel: true,
        score: true,
        automated: true,
        upVotes: true,
        downVotes: true,
        needsReview: true,
      },
    });

    tagsVar = rawTags.map(({ tagId, tagName, tagType, tagNsfwLevel, ...tag }) => ({
      ...tag,
      id: tagId,
      type: tagType,
      nsfwLevel: tagNsfwLevel as NsfwLevel,
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
      meta: ImageMetaProps | null;
      tags?: VotableTagModel[] | undefined;
      names?: string[];
      report?:
        | {
            id: number;
            reason: string;
            details: Prisma.JsonValue;
            status: ReportStatus;
            count: number;
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
      reportCount,
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
            count: (reportCount ?? 0) + 1,
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
  const imagesRaw = await dbRead.$queryRaw<
    { url: string; username: string; meta: ImageMetaProps | null }[]
  >`
    SELECT
      u.username,
      i.url,
      i.meta
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId" AND username IS NOT NULL
    JOIN "Collection" c ON c.id = ci."collectionId"
    WHERE c."userId" = -1
      AND c.name = '404 Contest'
      AND i."ingestion" = 'Scanned'
      AND i."needsReview" IS NULL
      AND (i."nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0
      AND ci.status = 'ACCEPTED';
  `;

  const images = Object.values(imagesRaw).map(({ meta, username, url }) => {
    const alt = truncate(meta?.prompt, { length: constants.altTruncateLength });
    return [username, url, alt];
  });

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

export async function reportCsamImages({
  imageIds,
  user,
  ip,
}: ReportCsamImagesInput & {
  user: SessionUser;
  ip?: string;
}) {
  if (!user.isModerator) throw throwAuthorizationError();
  await dbWrite.image.updateMany({
    where: { id: { in: imageIds } },
    data: { needsReview: 'csam' },
  });
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { reports: { select: { reportId: true } } },
  });
  const reportIds = images.flatMap((x) => x.reports.map((x) => x.reportId));
  await bulkSetReportStatus({ ids: reportIds, status: ReportStatus.Actioned, userId: user.id, ip });
}

export async function ingestArticleCoverImages(array: { imageId: number; articleId: number }[]) {
  const imageIds = array.map((x) => x.imageId);
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, url: true, height: true, width: true },
  });

  await articlesSearchIndex.queueUpdate(
    array.map((x) => ({ id: x.articleId, action: SearchIndexUpdateQueueAction.Update }))
  );

  await ingestImageBulk({ images, lowPriority: true });
}

export async function updateImageNsfwLevel({
  id,
  nsfwLevel,
  user,
  status,
}: UpdateImageNsfwLevelOutput & { user: SessionUser }) {
  if (!nsfwLevel) throw throwBadRequestError();
  if (user.isModerator) {
    await dbWrite.image.update({ where: { id }, data: { nsfwLevel, nsfwLevelLocked: true } });
    if (status) {
      await dbWrite.imageRatingRequest.updateMany({
        where: { imageId: id, status: 'Pending' },
        data: { status },
      });
    }
    await trackModActivity(user.id, {
      entityType: 'image',
      entityId: id,
      activity: 'setNsfwLevel',
    });
  } else {
    await dbWrite.imageRatingRequest.upsert({
      where: { imageId_userId: { imageId: id, userId: user.id } },
      create: { nsfwLevel, imageId: id, userId: user.id },
      update: { nsfwLevel },
    });

    // Track potential content leaking
    // If the image is currently PG and the new level is R or higher, and the image isn't from the original user, increment the counter
    const current = await dbWrite.image.findFirst({
      where: { id },
      select: { nsfwLevel: true, userId: true },
    });
    if (
      current?.nsfwLevel === NsfwLevel.PG &&
      nsfwLevel >= NsfwLevel.R &&
      current?.userId !== user.id
    ) {
      leakingContentCounter.inc();
    }
  }
}

type ImageRatingRequestResponse = {
  id: number;
  votes: {
    [NsfwLevel.PG]: NsfwLevel.PG;
    [NsfwLevel.PG13]: NsfwLevel.PG13;
    [NsfwLevel.R]: NsfwLevel.R;
    [NsfwLevel.X]: NsfwLevel.X;
    [NsfwLevel.XXX]: NsfwLevel.XXX;
  };
  url: string;
  nsfwLevel: number;
  nsfwLevelLocked: boolean;
  width: number | null;
  height: number | null;
  type: MediaType;
  total: number;
  ownerVote: number;
  createdAt: Date;
};

export async function getImageRatingRequests({
  cursor,
  limit,
  user,
}: ImageRatingReviewOutput & { user: SessionUser }) {
  const results = await dbRead.$queryRaw<ImageRatingRequestResponse[]>`
    WITH CTE_Requests AS (
      SELECT
        DISTINCT ON (irr."imageId") irr."imageId" as id,
        MIN(irr."createdAt") "createdAt",
        COUNT(CASE WHEN i."nsfwLevel" != irr."nsfwLevel" THEN i.id END)::INT "total",
        COALESCE(SUM(CASE WHEN irr."userId" = i."userId" THEN irr."nsfwLevel" ELSE 0 END))::INT "ownerVote",
        i.url,
        i."nsfwLevel",
        i."nsfwLevelLocked",
        i.type,
        i.height,
        i.width,
        jsonb_build_object(
          ${NsfwLevel.PG}, count(irr."nsfwLevel")
            FILTER (where irr."nsfwLevel" = ${NsfwLevel.PG}),
          ${NsfwLevel.PG13}, count(irr."nsfwLevel")
            FILTER (where irr."nsfwLevel" = ${NsfwLevel.PG13}),
          ${NsfwLevel.R}, count(irr."nsfwLevel")
            FILTER (where irr."nsfwLevel" = ${NsfwLevel.R}),
          ${NsfwLevel.X}, count(irr."nsfwLevel")
            FILTER (where irr."nsfwLevel" = ${NsfwLevel.X}),
          ${NsfwLevel.XXX}, count(irr."nsfwLevel")
            FILTER (where irr."nsfwLevel" = ${NsfwLevel.XXX})
        ) "votes"
        FROM "ImageRatingRequest" irr
        JOIN "Image" i on i.id = irr."imageId"
        WHERE irr.status = ${ReportStatus.Pending}::"ReportStatus"
          AND i."nsfwLevel" != ${NsfwLevel.Blocked}
        GROUP BY irr."imageId", i.id
    )
    SELECT
      r.*
    FROM CTE_Requests r
    WHERE (r.total >= 3 OR (r."ownerVote" != 0 AND r."ownerVote" != r."nsfwLevel"))
    ${!!cursor ? Prisma.sql` AND r."createdAt" >= ${new Date(cursor)}` : Prisma.sql``}
    ORDER BY r."createdAt"
    LIMIT ${limit + 1}
  `;

  let nextCursor: string | undefined;
  if (limit && results.length > limit) {
    const nextItem = results.pop();
    nextCursor = nextItem?.createdAt.toISOString() || undefined;
  }

  const imageIds = results.map((x) => x.id);
  const tags = await getVotableTags2({
    ids: imageIds,
    user,
    type: 'image',
    nsfwLevel: Flags.arrayToInstance([NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX]),
  });

  return {
    nextCursor,
    items: results.map((item) => ({ ...item, tags: tags.filter((x) => x.imageId === item.id) })),
  };
}

// #region [image tools]
async function authorizeImagesAction({
  imageIds,
  user,
}: {
  imageIds: number[];
  user: SessionUser;
}) {
  if (!user.isModerator) {
    const images = await dbRead.image.findMany({
      where: { id: { in: imageIds }, userId: user.id },
      select: { id: true },
    });
    const validatedIds = images.map((x) => x.id);
    if (!imageIds.every((id) => validatedIds.includes(id))) throw throwAuthorizationError();
  }
}

export async function addImageTools({
  data,
  user,
}: {
  data: AddOrRemoveImageToolsOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  await dbWrite.imageTool.createMany({ data, skipDuplicates: true });
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }
}

export async function removeImageTools({
  data,
  user,
}: {
  data: AddOrRemoveImageToolsOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  const toolsByImage = data.reduce<Record<number, number[]>>((acc, { imageId, toolId }) => {
    if (!acc[imageId]) acc[imageId] = [];
    acc[imageId].push(toolId);
    return acc;
  }, {});

  await dbWrite.$transaction(
    Object.entries(toolsByImage).map(([imageId, toolIds]) =>
      dbWrite.imageTool.deleteMany({ where: { imageId: Number(imageId), toolId: { in: toolIds } } })
    )
  );
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }
}

export async function updateImageTools({
  data,
  user,
}: {
  data: UpdateImageToolsOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  await dbWrite.$transaction(
    data.map(({ imageId, toolId, notes }) =>
      dbWrite.imageTool.update({
        where: { imageId_toolId: { imageId, toolId } },
        data: { notes },
        select: { imageId: true },
      })
    )
  );
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }
}
// #endregion

// #region [image techniques]
export async function addImageTechniques({
  data,
  user,
}: {
  data: AddOrRemoveImageTechniquesOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  await dbWrite.imageTechnique.createMany({ data, skipDuplicates: true });
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }
}

export async function removeImageTechniques({
  data,
  user,
}: {
  data: AddOrRemoveImageTechniquesOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  const techniquesByImage = data.reduce<Record<number, number[]>>(
    (acc, { imageId, techniqueId }) => {
      if (!acc[imageId]) acc[imageId] = [];
      acc[imageId].push(techniqueId);
      return acc;
    },
    {}
  );

  await dbWrite.$transaction(
    Object.entries(techniquesByImage).map(([imageId, techniqueIds]) =>
      dbWrite.imageTechnique.deleteMany({
        where: { imageId: Number(imageId), techniqueId: { in: techniqueIds } },
      })
    )
  );

  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }
}

export async function updateImageTechniques({
  data,
  user,
}: {
  data: UpdateImageTechniqueOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  await dbWrite.$transaction(
    data.map(({ imageId, techniqueId, notes }) =>
      dbWrite.imageTechnique.update({
        where: { imageId_techniqueId: { imageId, techniqueId } },
        data: { notes },
        select: { imageId: true },
      })
    )
  );
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }
}
// #endregion

export function purgeImageGenerationDataCache(id: number) {
  purgeCache({ tags: [`image-generation-data-${id}`] });
}
const strengthTypes: ModelType[] = ['TextualInversion', 'LORA', 'DoRA', 'LoCon'];
export async function getImageGenerationData({ id }: { id: number }) {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: {
      hideMeta: true,
      generationProcess: true,
      meta: true,
      type: true,
      tools: {
        select: {
          notes: true,
          tool: {
            select: {
              id: true,
              name: true,
              icon: true,
              domain: true,
            },
          },
        },
      },
      techniques: {
        select: {
          notes: true,
          technique: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });
  if (!image) throw throwNotFoundError();

  const tools = image.tools.map(({ notes, tool }) => ({ ...tool, notes }));
  const techniques = image.techniques.map(({ notes, technique }) => ({ ...technique, notes }));

  const { rows: resources } = await pgDbRead.query<{
    id: number;
    strength?: number;
    modelId: number;
    modelName: string;
    modelType: ModelType;
    versionId: number;
    versionName: string;
  }>(Prisma.sql`
    SELECT
      ir.id,
      ir.strength,
      m.id as "modelId",
      m.name as "modelName",
      m.type as "modelType",
      mv.id as "versionId",
      mv.name as "versionName"
    FROM "ImageResource" ir
    JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
    JOIN "Model" m on mv."modelId" = m.id
      WHERE ir."imageId" = ${id}
  `);

  const parsedMeta = imageMetaOutput.safeParse(image.meta);
  const data = parsedMeta.success ? parsedMeta.data : {};
  const { 'Clip skip': legacyClipSkip, clipSkip = legacyClipSkip, external, ...rest } = data;
  const meta =
    parsedMeta.success && !image.hideMeta ? removeEmpty({ ...rest, clipSkip }) : undefined;

  return {
    meta,
    resources: resources.map((resource) => ({
      ...resource,
      strength:
        strengthTypes.includes(resource.modelType) && resource.strength
          ? resource.strength / 100
          : undefined,
    })),
    tools,
    techniques,
    external,
    canRemix: !image.hideMeta && !!meta?.prompt,
    generationProcess: image.generationProcess,
  };
}

export const getImageContestCollectionDetails = async ({ id }: GetByIdInput) => {
  const items = await dbRead.collectionItem.findMany({
    where: {
      collection: {
        mode: CollectionMode.Contest,
      },
      imageId: id,
    },
    select: {
      imageId: true,
      status: true,
      createdAt: true,
      reviewedAt: true,
      collection: {
        select: collectionSelect,
      },
      tag: true,
    },
  });

  return items.map((i) => ({
    ...i,
    collection: {
      ...i.collection,
      metadata: (i.collection.metadata ?? {}) as CollectionMetadataSchema,
      tags: i.collection.tags.map((t) => t.tag),
    },
  }));
};

// this method should hopefully not be a lasting addition
export type ModerationImageModel = AsyncReturnType<typeof getImagesByUserIdForModeration>[number];
export async function getImagesByUserIdForModeration(userId: number) {
  return await dbRead.image.findMany({
    where: { userId },
    select: { ...imageSelect, user: { select: simpleUserSelect } },
  });
}
