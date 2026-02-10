import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import type { ManipulateType } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';
import { chunk, truncate, uniqBy } from 'lodash-es';
import { MeiliSearch, type SearchParams } from 'meilisearch';
import type { SessionUser } from 'next-auth';
import { v4 as uuid } from 'uuid';
import { isDev, isProd } from '~/env/other';
import { env } from '~/env/server';
import type { VotableTagModel } from '~/libs/tags';
import { clickhouse } from '~/server/clickhouse/client';
import { purgeCache } from '~/server/cloudflare/client';
import {
  CacheTTL,
  constants,
  METRICS_IMAGES_SEARCH_INDEX,
  nsfwRestrictedBaseModels,
} from '~/server/common/constants';
import {
  BlockedReason,
  ImageScanType,
  ImageSort,
  NotificationCategory,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-lag-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { poolCounters } from '~/server/games/new-order/utils';
import { logToAxiom } from '~/server/logging/client';
import { metricsSearchClient } from '~/server/meilisearch/client';
import { postMetrics } from '~/server/metrics';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import { leakingContentCounter } from '~/server/prom/client';
import {
  getBaseModelFromResources,
  getUserFollows,
  imageMetaCache,
  imageMetadataCache,
  imageResourcesCache,
  imageTagsCache,
  tagCache,
  tagIdsForImagesCache,
  thumbnailCache,
  userImageVideoCountCache,
} from '~/server/redis/caches';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { imageMetricsCache } from '~/server/redis/entity-metric-populate';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { createLruCache } from '~/server/utils/lru-cache';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import type {
  AddOrRemoveImageTechniquesOutput,
  AddOrRemoveImageToolsOutput,
  DownleveledReviewOutput,
  GetEntitiesCoverImage,
  GetImageInput,
  GetInfiniteImagesOutput,
  GetMyImagesInput,
  ImageEntityType,
  ImageMetaProps,
  ImageModerationBlockSchema,
  ImageModerationSchema,
  ImageModerationUnblockSchema,
  ImageRatingReviewOutput,
  ImageReviewQueueInput,
  ImageSchema,
  ImageUploadProps,
  IngestImageInput,
  RemoveImageResourceSchema,
  ReportCsamImagesInput,
  SetVideoThumbnailInput,
  ToggleImageFlagInput,
  UpdateImageAcceptableMinorInput,
  UpdateImageNsfwLevelOutput,
  UpdateImageTechniqueOutput,
  UpdateImageToolsOutput,
} from '~/server/schema/image.schema';
import { imageMetaOutput, ingestImageSchema } from '~/server/schema/image.schema';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import {
  articlesSearchIndex,
  imagesMetricsSearchIndex,
  imagesSearchIndex,
} from '~/server/search-index';
import type {
  ImageMetricsSearchIndexRecord,
  MetricsImageFilterableAttribute,
  MetricsImageSortableAttribute,
} from '~/server/search-index/metrics-images.search-index';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import type { ImageResourceHelperModel } from '~/server/selectors/image.selector';
import { imageSelect } from '~/server/selectors/image.selector';
import type { ImageV2Model } from '~/server/selectors/imagev2.selector';
import { imageTagCompositeSelect, simpleTagSelect } from '~/server/selectors/tag.selector';
import {
  getCollectionRandomSeed,
  getUserCollectionPermissionsById,
  getUserCollectionPermissionsByIds,
  removeEntityFromAllCollections,
} from '~/server/services/collection.service';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { addImageToQueue } from '~/server/services/games/new-order.service';
import { upsertImageFlag } from '~/server/services/image-flag.service';
import {
  deleteImagTagsForReviewByImageIds,
  getImagTagsForReviewByImageIds,
} from '~/server/services/image-review.service';
import type { ImageModActivity } from '~/server/services/moderator.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { createNotification } from '~/server/services/notification.service';
import { bustCachesForPosts, updatePostNsfwLevel } from '~/server/services/post.service';
import { bulkSetReportStatus } from '~/server/services/report.service';
import { getVotableTags2 } from '~/server/services/tag.service';
import { upsertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import {
  getBasicDataForUsers,
  getCosmeticsForUsers,
  getProfilePicturesForUsers,
} from '~/server/services/user.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { Limiter, limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { RuleDefinition } from '~/server/utils/mod-rules';
import { getCursor } from '~/server/utils/pagination-helpers';
import {
  nsfwBrowsingLevelsArray,
  nsfwBrowsingLevelsFlag,
  onlySelectableLevels,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type {
  ModelType,
  ReportReason,
  ReviewReactions,
  TagType,
} from '~/shared/utils/prisma/enums';
import {
  Availability,
  BlockImageReason,
  CollectionMode,
  EntityType,
  ImageIngestionStatus,
  MediaType,
  NewOrderRankType,
  ReportStatus,
} from '~/shared/utils/prisma/enums';
import { withRetries } from '~/utils/errorHandling';
import { fetchBlob } from '~/utils/file-utils';
import { getMetadata } from '~/utils/metadata';
import { removeEmpty } from '~/utils/object-helpers';
import { imageS3Client } from '~/utils/s3-client';
import { serverUploadImage } from '~/utils/s3-utils';
import { isDefined, isNumber } from '~/utils/type-guards';
import FliptSingleton, { FLIPT_FEATURE_FLAGS, isFlipt } from '../flipt/client';
import { ensureRegisterFeedImageExistenceCheckMetrics } from '../metrics/feed-image-existence-check.metrics';
import client from 'prom-client';
import { getExplainSql } from '~/server/db/db-helpers';
import { ImagesFeed } from '../../../event-engine-common/feeds';
import { MetricService } from '../../../event-engine-common/services/metrics';
import { CacheService } from '../../../event-engine-common/services/cache';
import type { IMeilisearch } from '../../../event-engine-common/types/meilisearch-interface';
import type {
  IClickhouseClient,
  IDbClient,
  IRedisClient,
} from '../../../event-engine-common/types/package-stubs';
import type { FeedQueryInput } from '../../../event-engine-common/feeds/types';
import type { ImageQueryInput } from '../../../event-engine-common/types/image-feed-types';
import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';

const {
  cacheHitRequestsTotal,
  ffRequestsTotal,
  requestDurationSeconds,
  requestTotal,
  droppedIdsTotal,
} = ensureRegisterFeedImageExistenceCheckMetrics(client.register);

// no user should have to see images on the site that haven't been scanned or are queued for removal

export async function purgeResizeCache({ url }: { url: string }) {
  // Purge from new cache bucket
  const { items } = await imageS3Client.listObjects({
    bucket: env.S3_IMAGE_CACHE_BUCKET,
    prefix: url,
  });
  const keys = items.map((x) => x.Key).filter(isDefined);
  if (keys.length) {
    await imageS3Client.deleteManyObjects({
      bucket: env.S3_IMAGE_CACHE_BUCKET,
      keys,
    });
  }
}

export async function deleteImageFromS3({ id, url }: { id: number; url: string }) {
  if (!env.DATABASE_IS_PROD) return;

  try {
    const otherImagesWithSameUrl = await dbWrite.image.findFirst({
      select: { id: true },
      where: {
        url: url,
        id: { not: id },
      },
    });

    if (!!otherImagesWithSameUrl) return;

    await withRetries(() =>
      imageS3Client.deleteObject({ bucket: env.S3_IMAGE_UPLOAD_BUCKET, key: url })
    );
    await purgeResizeCache({ url: url });
  } catch (e) {
    // do nothing
  }
}

export const invalidateManyImageExistence = async (ids: number[]) => {
  // Set keys individually to avoid CROSSSLOT errors
  await Promise.all(
    ids.map((id) =>
      sysRedis.packed.set(
        `${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${id}` as RedisKeyTemplateSys,
        'false',
        { EX: 60 * 5 }
      )
    )
  );
};

async function getImageTagsForImages(
  imageIds: number[]
): Promise<(VotableTagModel & { imageId: number })[]> {
  const tagsByImage = await imageTagsCache.fetch(imageIds);

  return imageIds.flatMap(
    (imageId) =>
      tagsByImage[imageId]?.tags.map(({ tagId, tagName, tagType, tagNsfwLevel, ...tag }) => ({
        ...tag,
        imageId,
        id: tagId,
        type: tagType,
        nsfwLevel: tagNsfwLevel as NsfwLevel,
        name: tagName,
      })) ?? []
  );
}

export const deleteImageById = async ({
  id,
  updatePost,
}: GetByIdInput & { updatePost?: boolean }) => {
  updatePost ??= true;
  try {
    // Remove image from all collections before deleting
    await removeEntityFromAllCollections('image', id);

    const image = await dbWrite.image.delete({
      where: { id },
      select: { url: true, postId: true, nsfwLevel: true, userId: true },
    });
    if (!image) return;

    const invalidateExistence = invalidateManyImageExistence([id]);

    await Promise.all([
      deleteImageFromS3({ id, url: image.url }),
      queueImageSearchIndexUpdate({
        ids: [id],
        action: SearchIndexUpdateQueueAction.Delete,
      }),
      ...(updatePost && image.postId
        ? [
            updatePostNsfwLevel(image.postId),
            bustCachesForPosts(image.postId),
            postMetrics.queueUpdate(image.postId),
          ]
        : []),
      invalidateExistence,
    ]);

    return image;
  } catch {
    // Ignore errors
  }
};

export async function deleteImages(ids: number[], updatePosts = true) {
  const images = await Limiter({ batchSize: 100 }).process(ids, async (ids, batchIndex) => {
    // Remove images from all collections before deleting
    // Note: Since we're using raw SQL delete, Prisma cascades won't trigger automatically
    await Promise.all(ids.map((id) => removeEntityFromAllCollections('image', id)));

    const results = await dbWrite.$queryRaw<
      { id: number; url: string; postId: number | null; nsfwLevel: number; userId: number }[]
    >`
      DELETE FROM "Image"
      WHERE id IN (${Prisma.join(ids)})
      RETURNING id, url, "postId", "nsfwLevel", "userId"
    `;
    const imageIds = results.map((x) => x.id);
    const idsForPostUpdate = updatePosts ? results.map((x) => x.postId).filter(isDefined) : [];

    const invalidateExistence = invalidateManyImageExistence(idsForPostUpdate);

    await Promise.all([
      queueImageSearchIndexUpdate({
        ids: imageIds,
        action: SearchIndexUpdateQueueAction.Delete,
      }),
      updatePostNsfwLevel(idsForPostUpdate),
      bustCachesForPosts(idsForPostUpdate),
      postMetrics.queueUpdate(idsForPostUpdate),
      invalidateExistence,
    ]);

    await Limiter({ batchSize: 5 }).process(
      results,
      async (results) =>
        await Promise.all(results.map(({ id, url }) => deleteImageFromS3({ id, url })))
    );
    if (isDev) console.log(`Batch ${batchIndex}: Deleted ${results.length} images`);

    return results;
  });

  return images;
}

function getReviewTypeToBlockedReason(reason: string) {
  switch (reason) {
    case 'csam':
      return BlockImageReason.CSAM;
    case 'newUser':
      return BlockImageReason.Ownership;
    case 'minor':
    case 'poi':
    case 'reported':
    case 'blocked':
    case 'tag':
    case 'appeal':
    case 'modRule':
    default:
      return BlockImageReason.TOS;
  }
}

export async function handleUnblockImages({
  ids: imageIds,
  moderatorId,
}: ImageModerationUnblockSchema) {
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: {
      id: true,
      userId: true,
      pHash: true,
      postId: true,
      nsfwLevel: true,
      blockedFor: true,
      needsReview: true,
    },
  });
  await Limiter().process(images, async (images) => {
    const ids = images.map((x) => x.id);
    const grouped = images.reduce<Record<string, number[]>>((acc, image) => {
      if (!image.needsReview) image.needsReview = 'null';
      if (!acc[image.needsReview]) acc[image.needsReview] = [];
      acc[image.needsReview].push(image.id);
      return acc;
    }, {});

    const imageTagsForReview = await getImagTagsForReviewByImageIds(ids);
    await Promise.all([
      ...Object.entries(grouped).map(
        ([needsReview, groupedIds]) => dbWrite.$queryRaw`
          UPDATE "Image" SET
            "needsReview" = NULL,
            "blockedFor" = NULL,
            "metadata" = "metadata" - 'ruleId' - 'ruleReason', -- Remove ruleId and ruleReason from metadata
            ${needsReview === 'poi' ? Prisma.sql`"poi" = false,` : Prisma.sql``}
            ${
              needsReview === 'minor'
                ? Prisma.sql`"minor" = CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE END,`
                : Prisma.sql``
            }
            ${
              ['minor', 'poi', 'newUser', 'bestiality'].includes(needsReview)
                ? Prisma.sql`"scannedAt" = NOW(),`
                : Prisma.sql``
            }
            "ingestion" = 'Scanned'
          WHERE id IN (${Prisma.join(groupedIds)});
        `
      ),
      upsertTagsOnImageNew(
        imageTagsForReview.map(({ imageId, tagId }) => ({
          imageId,
          tagId,
          disabled: true,
          needsReview: false,
        }))
      ),
    ]);

    await Promise.all([
      updateNsfwLevel(ids),
      queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Update }),
      deleteImagTagsForReviewByImageIds(ids),
      bulkRemoveBlockedImages(images.map(({ pHash }) => pHash).filter(isDefined)),
    ]);

    if (moderatorId) {
      await trackModActivity(moderatorId, {
        entityType: 'image',
        entityId: ids,
        activity: 'review',
      });
    }
  });
  return images;
}

export async function handleBlockImages({
  ids: imageIds,
  userId,
  include,
  moderatorId,
}: ImageModerationBlockSchema) {
  if (!imageIds?.length && !userId) throw new Error('one of "ids" or "userId" is required');
  const images = await dbRead.image.findMany({
    where: { id: imageIds ? { in: imageIds } : undefined, userId },
    select: {
      id: true,
      userId: true,
      pHash: true,
      postId: true,
      nsfwLevel: true,
      blockedFor: true,
      needsReview: true,
    },
  });
  await Limiter({ batchSize: 100, limit: 10 }).process(images, async (images) => {
    const ids = images.map((x) => x.id);
    const invalidateExistence = invalidateManyImageExistence(ids);

    await Promise.all([
      dbWrite.image.updateMany({
        where: { id: { in: ids } },
        data: {
          needsReview: null,
          ingestion: 'Blocked',
          nsfwLevel: NsfwLevel.Blocked,
          blockedFor: BlockedReason.Moderated,
          updatedAt: new Date(),
        },
      }),

      queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Delete }),
      invalidateExistence,
    ]);
    if (include?.includes('phash-block')) {
      await bulkAddBlockedImages({
        data: images
          .map(({ pHash, blockedFor }) => {
            if (!pHash) return null;
            return {
              hash: pHash,
              reason: getReviewTypeToBlockedReason(blockedFor ?? BlockedReason.Moderated),
            };
          })
          .filter(isDefined),
      });
    }
    if (include?.includes('user-notification')) {
      await Promise.all(
        images.map((img) =>
          createNotification({
            userId: img.userId,
            type: 'tos-violation',
            category: NotificationCategory.System,
            key: `tos-violation:image:${uuid()}`,
            details: {
              modelName: img.postId ? `post #${img.postId}` : 'a post',
              entity: 'image',
              url: `/images/${img.id ?? ''}`,
            },
          }).catch()
        )
      );
    }

    if (moderatorId && !!imageIds?.length) {
      await trackModActivity(moderatorId, {
        entityType: 'image',
        entityId: ids,
        activity: 'review',
      });
    }
  });

  if (moderatorId && userId) {
    await trackModActivity(moderatorId, {
      entityType: 'user',
      entityId: userId,
      activity: 'removeContent',
    });
  }

  return images;
}

export const moderateImages = async (
  args: ImageModerationSchema & (ImageModerationUnblockSchema | ImageModerationBlockSchema)
) => {
  switch (args.reviewAction) {
    case 'unblock':
      return handleUnblockImages(args);
    case 'block':
      return handleBlockImages(args);
  }
};

export async function updateNsfwLevel(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  ids = [...new Set(ids)]; // dedupe
  if (!ids.length) return;
  await dbWrite.$executeRawUnsafe(
    `SELECT update_nsfw_levels_new(ARRAY[${ids.join(',')}]::integer[])`
  );
  await thumbnailCache.bust(ids);
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
  const [resourcesData, tagsData] = await Promise.all([
    imageResourcesCache.fetch([id]),
    imageTagsCache.fetch([id]),
  ]);

  const resources = (resourcesData[id]?.resources ?? []).map((r) => ({
    id: r.modelVersionId, // Use modelVersionId as identifier (ImageResourceNew has no id column)
    modelVersion: { id: r.modelVersionId, name: r.versionName },
    detected: r.detected,
  }));

  const tags = (tagsData[id]?.tags ?? []).map((t) => ({
    automated: t.automated,
    tag: {
      id: t.tagId,
      name: t.tagName,
      isCategory: false, // ImageTag doesn't have isCategory, default to false
    },
  }));

  return { resources, tags };
};

export const getImageById = async ({ id }: GetByIdInput) => {
  return await dbRead.image.findUnique({
    where: { id },
  });
};

export const ingestImageById = async ({ id }: GetByIdInput) => {
  const images = await dbWrite.$queryRaw<IngestImageInput[]>`
    SELECT id, url, type, width, height, meta->>'prompt' as prompt
    FROM "Image"
    WHERE id = ${id}
  `;
  if (!images?.length) throw new TRPCError({ code: 'NOT_FOUND' });

  const results = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    SELECT "imageId", "tagId"
    FROM "TagsOnImageDetails"
    WHERE "imageId" = ${images[0].id} AND NOT "disabled";
  `;

  await upsertTagsOnImageNew(
    results.map(({ imageId, tagId }) => ({ imageId, tagId, disabled: false }))
  );

  return await ingestImage({ image: images[0] });
};

// const scanner = env.EXTERNAL_IMAGE_SCANNER;
// const clavataScan = env.CLAVATA_SCAN;
export const imageScanTypes: ImageScanType[] = [
  ImageScanType.WD14,
  // ImageScanType.Hash,
  // ImageScanType.Clavata,
  // ImageScanType.Hive,
  ImageScanType.SpineRating,
];

export const ingestImage = async ({
  image,
  lowPriority,
  tx,
  userId,
}: {
  image: IngestImageInput;
  lowPriority?: boolean;
  tx?: Prisma.TransactionClient;
  userId?: number;
}): Promise<boolean> => {
  const scanRequestedAt = new Date();
  const dbClient = tx ?? dbWrite;

  if (!isProd || !env.IMAGE_SCANNING_ENDPOINT) {
    console.log('skipping image ingestion');
    const updated = await dbClient.image.update({
      where: { id: image.id },
      select: { postId: true },
      data: {
        scanRequestedAt,
        scannedAt: scanRequestedAt,
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: NsfwLevel.PG,
      },
    });

    // Update post NSFW level
    if (updated.postId) await updatePostNsfwLevel(updated.postId);

    return true;
  }

  const parsedImage = ingestImageSchema.safeParse(image);
  if (!parsedImage.success) throw new Error('Failed to parse image data');

  const { url, id, type, width, height } = parsedImage.data;

  const callbackUrl =
    env.IMAGE_SCANNING_CALLBACK ??
    `${env.NEXTAUTH_URL}/api/webhooks/image-scan-result?token=${env.WEBHOOK_TOKEN}`;

  if (!image.prompt) {
    const { prompt } = await dbClient.$queryRaw<{ prompt?: string }>`
      SELECT meta->>'prompt' as prompt FROM "Image" WHERE id = ${id}
    `;
    image.prompt = prompt;
  }

  if (env.IMAGE_SCANNER_NEW || userId === 5) {
    const workflowResponse = await createImageIngestionRequest({
      imageId: id,
      url,
      type,
      callbackUrl,
      priority: lowPriority ? 'low' : undefined,
    });
    if (!workflowResponse) return false;
    const scanJobsJson = JSON.stringify({ workflowId: workflowResponse.id });
    await dbClient.$executeRaw`
        UPDATE "Image"
        SET
          "scanRequestedAt" = ${scanRequestedAt},
          "scanJobs" = CASE
            WHEN "scanJobs" IS NOT NULL AND "scanJobs" ? 'retryCount' THEN
              ${scanJobsJson}::jsonb || jsonb_build_object('retryCount', ("scanJobs"->'retryCount'))
            ELSE
              ${scanJobsJson}::jsonb
          END
        WHERE id = ${id}
      `;
    return true;
  }

  let scanUrl = `${env.IMAGE_SCANNING_ENDPOINT}/enqueue`;
  if (lowPriority) scanUrl += '?lowpri=true';

  const response = await fetch(scanUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageId: id,
      imageKey: url,
      type,
      width,
      height,
      prompt: image.prompt,
      // wait: true,
      scans: imageScanTypes,
      callbackUrl,
      movieRatingModel: env.IMAGE_SCANNING_MODEL,
    }),
  });
  if (response.status === 202) {
    const scanJobs = (await response.json().catch(() => Prisma.JsonNull)) as
      | { jobId: string }
      | typeof Prisma.JsonNull;

    // Convert scanJobs to JSON string for raw SQL, preserving existing retryCount if it exists
    const scanJobsJson = scanJobs === Prisma.JsonNull ? null : JSON.stringify(scanJobs);

    if (scanJobsJson) {
      await dbClient.$executeRaw`
        UPDATE "Image"
        SET
          "scanRequestedAt" = ${scanRequestedAt},
          "scanJobs" = CASE
            WHEN "scanJobs" IS NOT NULL AND "scanJobs" ? 'retryCount' THEN
              ${scanJobsJson}::jsonb || jsonb_build_object('retryCount', ("scanJobs"->'retryCount'))
            ELSE
              ${scanJobsJson}::jsonb
          END
        WHERE id = ${id}
      `;
    } else {
      await dbClient.$executeRaw`
        UPDATE "Image"
        SET "scanRequestedAt" = ${scanRequestedAt}
        WHERE id = ${id}
      `;
    }

    return true;
  } else {
    await logToAxiom({
      name: 'image-ingestion',
      type: 'error',
      imageId: id,
      url,
      responseStatus: response.status,
    });

    return false;
  }
};

export const ingestImageBulk = async ({
  images,
  tx,
  lowPriority = true,
  scans,
}: {
  images: IngestImageInput[];
  tx?: Prisma.TransactionClient;
  lowPriority?: boolean;
  scans?: ImageScanType[];
}): Promise<boolean> => {
  if (!env.IMAGE_SCANNING_ENDPOINT)
    throw new Error('missing IMAGE_SCANNING_ENDPOINT environment variable');

  const callbackUrl = env.IMAGE_SCANNING_CALLBACK;
  const scanRequestedAt = new Date();
  const imageIds = images.map(({ id }) => id);
  const dbClient = tx ?? dbWrite;

  if (!imageIds.length) return false;

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

  const needsPrompts = !images.some((x) => x.prompt);
  if (needsPrompts) {
    const prompts = await dbClient.$queryRaw<{ id: number; prompt?: string }[]>`
      SELECT id, meta->>'prompt' as prompt FROM "Image" WHERE id IN (${Prisma.join(imageIds)})
    `;
    const promptMap = Object.fromEntries(prompts.map((x) => [x.id, x.prompt]));
    for (const image of images) image.prompt = promptMap[image.id];
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
          prompt: image.prompt,
          scans: scans ?? imageScanTypes,
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
// export function applyUserPreferencesSql(
//   AND: Prisma.Sql[],
//   {
//     excludedUserIds,
//     excludedImageIds,
//     excludedTagIds,
//     userId,
//     hidden,
//   }: UserPreferencesInput & { userId?: number; hidden?: boolean }
// ) {
//   // Exclude specific users
//   if (excludedUserIds?.length)
//     AND.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
//
//   // Exclude specific images
//   if (excludedImageIds?.length) {
//     AND.push(
//       hidden
//         ? Prisma.sql`i."id" IN (${Prisma.join(excludedImageIds)})`
//         : Prisma.sql`i."id" NOT IN (${Prisma.join(excludedImageIds)})`
//     );
//   }
//
//   // Exclude specific tags
//   if (excludedTagIds?.length) {
//     const OR = [
//       Prisma.join(
//         [
//           Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
//           Prisma.sql`NOT EXISTS (
//           SELECT 1 FROM "TagsOnImageDetails" toi
//           WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join([
//             ...new Set(excludedTagIds),
//           ])}) AND NOT toi.disabled
//         )`,
//         ],
//         ' AND '
//       ),
//     ];
//     if (userId) OR.push(Prisma.sql`i."userId" = ${userId}`);
//     AND.push(Prisma.sql`(${Prisma.join(OR, ' OR ')})`);
//   }
//
//   return AND;
// }

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
  createdAt: Date;
  sortAt: Date;
  mimeType: string | null;
  scannedAt: Date | null;
  ingestion: ImageIngestionStatus;
  blockedFor: BlockedReason | null;
  needsReview: string | null;
  userId: number;
  index: number | null;
  postId: number | null;
  postTitle: string | null;
  modelVersionId: number | null;
  imageId: number | null;
  publishedAt: Date | null;
  unpublishedAt?: Date | null;
  cursorId?: string;
  type: MediaType;
  metadata: ImageMetadata | VideoMetadata | null;
  baseModel?: string;
  availability: Availability;
  minor: boolean;
  acceptableMinor: boolean;
  poi?: boolean;
  remixOfId?: number | null;
  hasPositivePrompt?: boolean;
};

type GetAllImagesInput = GetInfiniteImagesOutput & {
  useCombinedNsfwLevel?: boolean;
  user?: SessionUser;
  headers?: Record<string, string>; // TODO needed?
  useLogicalReplica: boolean;
};
export type ImagesInfiniteModel = AsyncReturnType<typeof getAllImages>['items'][0];
export const getAllImages = async (
  input: GetAllImagesInput & {
    userId?: number;
  }
) => {
  const {
    limit,
    cursor,
    skip,
    sort,
    postId,
    postIds,
    collectionId, // TODO - call this from separate method?
    modelId,
    modelVersionId,
    imageId, // used in public API
    username,
    period,
    periodMode,
    tags,
    generation,
    reviewId,
    prioritizedUserIds,
    include,
    // hideAutoResources,
    // hideManualResources,
    reactions,
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
    disablePoi,
    disableMinor,
    poiOnly,
    minorOnly,
  } = input;
  let { browsingLevel, userId: targetUserId, ids } = input;

  const AND: Prisma.Sql[] = [Prisma.sql`i."postId" IS NOT NULL`];
  const WITH: Prisma.Sql[] = [];
  let orderBy: string;
  // const cacheTags: string[] = [];
  // let cacheTime = CacheTTL.xs;
  const userId = user?.id;
  const isModerator = user?.isModerator ?? false;
  const includeCosmetics = include?.includes('cosmetics'); // TODO: This must be done similar to user cosmetics.

  // Exclude unselectable browsing levels
  browsingLevel = onlySelectableLevels(browsingLevel);

  // Parse random cursor seed upfront (needed to determine if we need to fetch seed)
  let parsedRandomCursorSeed: number | undefined;
  if (sort === ImageSort.Random && cursor) {
    const cursorStr = String(cursor);
    const parts = cursorStr.split(':');
    if (parts.length === 3) {
      parsedRandomCursorSeed = Number(parts[0]);
    }
  }

  // Prefetch independent async data in parallel
  const needsCollectionSeed = collectionId && sort === ImageSort.Random && !parsedRandomCursorSeed;
  const [
    prefetchedHiddenImages,
    prefetchedTargetUser,
    prefetchedIsFlipt,
    prefetchedUserFollows,
    prefetchedCollectionPermissions,
    prefetchedCollectionSeed,
  ] = await Promise.all([
    hidden && userId
      ? dbRead.imageEngagement.findMany({
          where: { userId, type: 'Hide' },
          select: { imageId: true },
        })
      : undefined,
    username && !targetUserId
      ? dbRead.user.findUnique({ where: { username }, select: { id: true } })
      : undefined,
    prioritizedUserIds?.length
      ? isFlipt('use-model-version-cache-for-images', modelVersionId?.toString(), {
          isModerator: isModerator.toString(),
          userId: userId?.toString() || 'anon',
        })
      : false,
    userId && followed ? getUserFollows(userId) : undefined,
    collectionId
      ? getUserCollectionPermissionsById({ userId, isModerator, id: collectionId })
      : undefined,
    needsCollectionSeed ? getCollectionRandomSeed() : undefined,
  ]);

  if (hidden) {
    if (!userId) throw throwAuthorizationError();
    const imageIds = prefetchedHiddenImages?.map((x) => x.imageId) ?? [];
    if (imageIds.length) {
      // cacheTime = 0;
      AND.push(Prisma.sql`i."id" IN (${Prisma.join(imageIds)})`);
    } else {
      return { items: [], nextCursor: undefined };
    }
  }

  if (username && !targetUserId) {
    if (!prefetchedTargetUser) throw new Error('User not found');
    targetUserId = prefetchedTargetUser.id;
  }

  // Hacked this to use the model version image cache instead
  const prioritizeUser = !!prioritizedUserIds?.length;
  const useModelVersionCache = prioritizeUser && prefetchedIsFlipt;
  if (prioritizeUser && useModelVersionCache) {
    if (cursor) throw new Error('Cannot use cursor with prioritizedUserIds');
    if (!modelVersionId)
      throw new Error('modelVersionId is required when using prioritizedUserIds');

    const cachedData = await imagesForModelVersionsCache.fetch([modelVersionId]);
    const versionData = cachedData[modelVersionId];
    if (!versionData || !versionData.images?.length) {
      return { items: [], nextCursor: undefined };
    }

    ids = versionData.images.map((img) => img.id);
  }

  // [x]
  if (ids && ids.length > 0) {
    AND.push(Prisma.sql`i."id" = ANY(${ids}::int[])`);
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
  } else if (!pending) AND.push(Prisma.sql`(p."publishedAt" < now())`);

  if (!isModerator) {
    AND.push(
      Prisma.sql`((p."availability" != ${Availability.Private} AND i."ingestion" != 'Blocked') OR p."userId" = ${userId})`
    );
  }

  if (disablePoi) {
    AND.push(Prisma.sql`(i."poi" != TRUE OR p."userId" = ${userId})`);
  }
  if (disableMinor) {
    AND.push(Prisma.sql`(i."minor" != TRUE)`);
  }

  if (isModerator) {
    if (poiOnly) {
      AND.push(Prisma.sql`(i."poi" = TRUE)`);
    }

    if (minorOnly) {
      AND.push(Prisma.sql`(i."minor" = TRUE)`);
    }
  }

  let from = 'FROM "Image" i';
  const joins: string[] = [];
  // Filter to specific model/review content
  if (!prioritizeUser && (modelId || modelVersionId || reviewId)) {
    from = `FROM "ImageResourceNew" irr`;
    joins.push(`JOIN "Image" i ON i.id = irr."imageId"`);
    if (reviewId) {
      joins.push(`JOIN "ResourceReview" re ON re."modelVersionId" = irr."modelVersionId"`);
      AND.push(Prisma.sql`re."id" = ${reviewId}`);
      // cacheTime = 0;
    } else if (modelVersionId) {
      AND.push(Prisma.sql`irr."modelVersionId" = ${modelVersionId}`);
      // cacheTime = CacheTTL.day;
      // cacheTags.push(`images-modelVersion:${modelVersionId}`);
    } else if (modelId) {
      joins.push(`JOIN "ModelVersion" mv ON mv.id = irr."modelVersionId"`);
      AND.push(Prisma.sql`mv."modelId" = ${modelId}`);
      // cacheTime = CacheTTL.day;
      // cacheTags.push(`images-model:${modelId}`);
    }
  }

  // [x] TODO remove
  if (targetUserId) {
    // WITH.push(
    //   Prisma.sql`collaboratingPosts AS (
    //     SELECT "entityId" id FROM "EntityCollaborator"
    //     WHERE "userId" = ${targetUserId}
    //       AND "entityType" = 'Post'
    //       AND "status" = 'Approved'
    //     )`
    // );

    AND.push(
      // TOOD: Due to performance reasons we cannot add this here yet. Will need to revise with other teams.
      // Prisma.sql`(i."userId" = ${targetUserId} OR i."postId" IN (SELECT id FROM collaboratingPosts))`
      Prisma.sql`i."userId" = ${targetUserId}`
    );
    // Don't cache self queries
    // cacheTime = 0;
    // if (targetUserId !== userId) {
    //   cacheTime = CacheTTL.day;
    //   cacheTags.push(`images-user:${targetUserId}`);
    // } else cacheTime = 0;
  }

  // Filter only followed users
  // [x]
  if (userId && followed && prefetchedUserFollows?.length) {
    // cacheTime = 0;
    AND.push(Prisma.sql`i."userId" IN (${Prisma.join(prefetchedUserFollows)})`);
  }

  // Filter to specific tags
  if (tags?.length) {
    AND.push(Prisma.sql`i.id IN (
      SELECT "imageId"
      FROM "TagsOnImageDetails"
      WHERE "tagId" IN (${Prisma.join(tags)}) AND "disabled" = FALSE
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
  if (imageId) AND.push(Prisma.sql`i.id = ${imageId}`);

  if (sort === ImageSort.Random && !collectionId) {
    throw throwBadRequestError('Random sort requires a collectionId');
  }

  if (collectionTagId && !collectionId) {
    throw throwBadRequestError('collectionTagId requires a collectionId');
  }

  // Filter to a specific collection and relevant status:
  // For random sort, parse seed from cursor (format: "seed:sortKey:id") for pagination continuity
  let collectionSeed: number | undefined;
  let parsedRandomCursor: { seed?: number; sortKey?: number; id?: number } | undefined;

  if (collectionId) {
    // Check if user has access to collection (prefetched)
    if (!prefetchedCollectionPermissions?.read) {
      return { nextCursor: undefined, items: [] };
    }

    const displayOwnedItems = userId
      ? ` OR (ci."status" <> 'REJECTED' AND ci."addedById" = ${userId})`
      : '';

    // For random sort, use prefetched seed or parse from cursor
    if (sort === ImageSort.Random) {
      if (cursor) {
        const cursorStr = String(cursor);
        const parts = cursorStr.split(':');
        if (parts.length === 3) {
          parsedRandomCursor = {
            seed: Number(parts[0]),
            sortKey: Number(parts[1]),
            id: Number(parts[2]),
          };
          collectionSeed = parsedRandomCursor.seed;
        }
      }
      // Use prefetched seed if not in cursor
      if (!collectionSeed) {
        collectionSeed = prefetchedCollectionSeed;
      }
    }

    const useRandomCursor = parsedRandomCursor && sort === ImageSort.Random;
    const seedStr = collectionSeed?.toString() ?? '';

    // Use subquery to compute hash once, then filter/sort on computed value
    WITH.push(
      Prisma.sql`
        ct AS (
          SELECT "imageId", "sortKey"
          FROM (
            SELECT
              ci."imageId",
              abs(mod(hashtext(concat(ci.id::text, '${Prisma.raw(
                seedStr
              )}')), 1000000000)) as "sortKey"
            FROM "CollectionItem" ci
            WHERE ci."collectionId" = ${collectionId}
              ${Prisma.raw(collectionTagId ? ` AND ci."tagId" = ${collectionTagId}` : ``)}
              AND ci."imageId" IS NOT NULL
              AND (
                (
                  ci."status" = 'ACCEPTED'
                )
                ${Prisma.raw(displayOwnedItems)}
              )
          ) sub
          ${Prisma.raw(
            useRandomCursor &&
              parsedRandomCursor?.sortKey !== undefined &&
              parsedRandomCursor?.id !== undefined
              ? `WHERE (
                  "sortKey" < ${parsedRandomCursor.sortKey}
                  OR (
                    "sortKey" = ${parsedRandomCursor.sortKey}
                    AND "imageId" < ${parsedRandomCursor.id}
                  )
                )`
              : ''
          )}
          ${Prisma.raw(sort === ImageSort.Random ? `ORDER BY "sortKey" DESC` : '')}
        )`
    );
  }

  if (excludedUserIds?.length) {
    AND.push(Prisma.sql`i."userId" NOT IN (${Prisma.join(excludedUserIds)})`);
  }

  const isGallery = modelId || modelVersionId || reviewId || userId;
  if (postId && !modelId) {
    // a post image query won't include modelId
    orderBy = `i."index"`;
  } else {
    // Sort by selected sort
    // if (sort === ImageSort.MostComments) {
    //   orderBy = `im."commentCount" DESC, im."reactionCount" DESC, im."imageId"`;
    //   if (!isGallery) AND.push(Prisma.sql`im."commentCount" > 0`);
    // } else if (sort === ImageSort.MostReactions) {
    //   orderBy = `im."reactionCount" DESC, im."heartCount" DESC, im."likeCount" DESC, im."imageId"`;
    //   if (!isGallery) AND.push(Prisma.sql`im."reactionCount" > 0`);
    // } else if (sort === ImageSort.MostCollected) {
    //   orderBy = `im."collectedCount" DESC, im."reactionCount" DESC, im."imageId"`;
    //   if (!isGallery) AND.push(Prisma.sql`im."collectedCount" > 0`);
    // }
    if (sort === ImageSort.Random) orderBy = 'ct."sortKey" DESC, i."id" DESC';
    // TODO this causes the app to spike
    // else if (sort === ImageSort.Oldest) {
    //   orderBy = 'i."sortAt" ASC';
    //   AND.push(Prisma.sql`i."sortAt" <= now()`);
    // } else {
    //   orderBy = 'i."sortAt" DESC';
    //   AND.push(Prisma.sql`i."sortAt" <= now()`);
    // }
    else if (sort === ImageSort.Oldest) orderBy = `i."id" ASC`;
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
  if (period && period !== 'AllTime' && periodMode !== 'stats') {
    const interval = period.toLowerCase();
    AND.push(
      Prisma.sql`i."createdAt" >= date_trunc('day', now()) - interval '1 ${Prisma.raw(interval)}'`
    );
  }

  // Handle cursor & skip conflict
  if (cursor && skip) throw new Error('Cannot use skip with cursor'); // [x]

  // Handle cursor prop - for random sort with collection, don't call getCursor since our cursor format is different
  let cursorClause: Prisma.Sql | undefined;
  let cursorProp: string | undefined;

  if (sort === ImageSort.Random && collectionSeed !== undefined) {
    // For random sort, generate compound cursor: seed:sortKey:id
    // Cursor handling is done in the CTE above, so we don't need cursorClause here
    cursorProp = `concat(${collectionSeed}::text, ':', ct."sortKey"::text, ':', i."id"::text)`;
    cursorClause = undefined;
  } else if (sort === ImageSort.Random) {
    cursorProp = 'i."id"';
    cursorClause = undefined;
  } else {
    // For non-random sort, use the standard getCursor helper
    const cursorResult = getCursor(orderBy, cursor);
    cursorClause = cursorResult.where;
    cursorProp = cursorResult.prop;
  }
  if (cursorClause) AND.push(cursorClause);

  if (prioritizeUser && !useModelVersionCache) {
    // [x]
    if (cursor) throw new Error('Cannot use cursor with prioritizedUserIds');
    if (modelVersionId) AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);

    // If system user, show community images
    const prioritizseIsSystemUser = prioritizedUserIds.length === 1 && prioritizedUserIds[0] === -1;

    // Confirm system user has posts:
    const hasSystemPosts =
      prioritizseIsSystemUser && modelVersionId
        ? await dbRead.post.findFirst({ where: { userId: -1, modelVersionId } })
        : false;

    if (prioritizseIsSystemUser && !hasSystemPosts)
      orderBy = `IIF(i."userId" IN (${prioritizedUserIds.join(',')}), i.index, 1000),  ${orderBy}`;
    else {
      // For everyone else, only show their images.
      AND.push(Prisma.sql`i."userId" IN (${Prisma.join(prioritizedUserIds)})`);
      orderBy = `(i."postId"::bigint * 100) + COALESCE(i."index", 0)`; // Order by oldest post first
    }
  }

  if (userId && !!reactions?.length) {
    // cacheTime = 0;
    // Use IN subquery - planner can start from reactions (small set per user) and join to images
    AND.push(Prisma.sql`i.id IN (
      SELECT ir."imageId" FROM "ImageReaction" ir
      WHERE ir."userId" = ${userId} AND ir.reaction IN (${Prisma.join(reactions)})
    )`);
  }

  if (!!tools?.length) {
    // Bring in images that contain the selected tools
    AND.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "ImageTool" it
      WHERE it."imageId" = i.id
      GROUP BY it."imageId"
      HAVING array_agg(it."toolId" ORDER BY it."toolId") @> ARRAY[${Prisma.join(tools)}]::integer[]
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
      RIGHT JOIN "ImageResourceNew" ir ON ir."imageId" = i.id AND ir."modelVersionId" = mv.id
      WHERE mv."baseModel" IN (${Prisma.join(baseModels)})
    )`);
  }

  if (pending && (isModerator || userId)) {
    if (isModerator) {
      AND.push(Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)`);
    } else if (userId) {
      AND.push(Prisma.sql`(i."needsReview" IS NULL OR i."userId" = ${userId})`);
      AND.push(
        Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR (i."nsfwLevel" = 0 AND i."userId" = ${userId}) OR (p."collectionId" IS NOT NULL AND EXISTS (SELECT 1 FROM "CollectionContributor" cc WHERE cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[] AND cc."collectionId" = p."collectionId" AND cc."userId" = ${userId})))`
      );
    }
  } else {
    AND.push(Prisma.sql`i."needsReview" IS NULL`);
    // Acceptable in collections, need to check for contest collection only
    if (!collectionId) AND.push(Prisma.sql`i."acceptableMinor" = FALSE`);
    AND.push(
      browsingLevel
        ? Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0 AND i."nsfwLevel" != 0`
        : Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );
  }

  // TODO: Adjust ImageMetric
  const queryFrom = Prisma.sql`
    ${Prisma.raw(from)}
    ${Prisma.raw(joins.join('\n'))}
    JOIN "Post" p ON p.id = i."postId"
    ${Prisma.raw(WITH.length && collectionId ? `JOIN ct ON ct."imageId" = i.id` : '')}
    WHERE ${Prisma.join(AND, ' AND ')}
      -- Filter out images with NSFW level that are linked to license-restricted base models
      -- Images with nsfwLevel >= 4 (R-XXX) cannot use base models with restricted licenses
      AND (
        (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
        OR NOT i."modelRestricted"
      )
  `;

  const engines = Object.keys(videoGenerationConfig2);
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
          WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            AND i.meta->>'prompt' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) AS "hasPositivePrompt",
      (
        CASE
          WHEN (i.meta->>'civitaiResources' IS NOT NULL AND NOT (i.meta ? 'Version'))
            OR i.meta->>'engine' IS NOT NULL AND i.meta->>'engine' = ANY(ARRAY[
              ${Prisma.join(engines)}
            ]::text[])
          THEN TRUE
          ELSE FALSE
        END
      ) as "onSite",
      i."meta"->'extra'->'remixOfId' as "remixOfId",
      i."createdAt",
      GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
      i."mimeType",
      i.type,
      i.metadata,
      i.ingestion,
      i."blockedFor",
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."postId",
      p."title" "postTitle",
      i."index",
      p."publishedAt",
      p.metadata->>'unpublishedAt' "unpublishedAt",
      p."modelVersionId",
      p."availability",
      i.minor,
      i.poi,
      i."acceptableMinor",
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
  const userIds = rawImages.map((i) => i.userId);
  const videoIds = rawImages.filter((x) => x.type === MediaType.video).map((x) => x.id);

  let nextCursor: string | undefined;
  if (rawImages.length > limit) {
    const nextItem = rawImages.pop();
    nextCursor = nextItem?.cursorId;
  }

  // Fetch all cache data in parallel
  const [
    reactionsRaw,
    tagIdsVar,
    tagsVar,
    userVotes,
    userBasicData,
    userCosmetics,
    profilePictures,
    cosmetics,
    thumbnails,
    imageMetrics,
    imageMeta,
    imageResources,
  ] = await Promise.all([
    userId
      ? dbRead.imageReaction.findMany({
          where: { imageId: { in: imageIds }, userId },
          select: { imageId: true, reaction: true },
        })
      : undefined,
    include?.includes('tagIds') ? tagIdsForImagesCache.fetch(imageIds) : undefined,
    include?.includes('tags') ? getImageTagsForImages(imageIds) : undefined,
    include?.includes('tags') && userId
      ? dbRead.tagsOnImageVote.findMany({
          where: { imageId: { in: imageIds }, userId },
          select: { imageId: true, tagId: true, vote: true },
        })
      : undefined,
    getBasicDataForUsers(userIds),
    includeCosmetics ? getCosmeticsForUsers(userIds) : undefined,
    include?.includes('profilePictures') ? getProfilePicturesForUsers(userIds) : undefined,
    includeCosmetics ? getCosmeticsForEntity({ ids: imageIds, entity: 'Image' }) : undefined,
    getThumbnailsForImages(videoIds),
    getImageMetricsObject(rawImages),
    include?.includes('metaSelect') ? getMetaForImages(imageIds) : undefined,
    includeBaseModel ? imageResourcesCache.fetch(imageIds) : undefined,
  ]);

  // Process reactions into lookup
  let userReactions: Record<number, ReviewReactions[]> | undefined;
  if (reactionsRaw) {
    userReactions = reactionsRaw.reduce((acc, { imageId, reaction }) => {
      acc[imageId] ??= [] as ReviewReactions[];
      acc[imageId].push(reaction);
      return acc;
    }, {} as Record<number, ReviewReactions[]>);
  }

  // Merge user votes into tags
  if (tagsVar && userVotes) {
    for (const tag of tagsVar) {
      const userVote = userVotes.find(
        (vote) => vote.tagId === tag.id && vote.imageId === tag.imageId
      );
      if (userVote) tag.vote = userVote.vote > 0 ? 1 : -1;
    }
  }

  const now = new Date();
  const filtered = rawImages.filter((x) => {
    if (isModerator) return true;
    // if (x.needsReview && x.userId !== userId) return false;
    if ((!x.publishedAt || x.publishedAt > now || !!x.unpublishedAt) && x.userId !== userId)
      return false;
    // if (x.ingestion !== 'Scanned' && x.userId !== userId) return false;
    return true;
  });

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
      modelVersionIds?: number[];
      modelVersionIdsManual?: number[];
      thumbnailUrl?: string;
      remixOfId?: number | null;
      hasPositivePrompt?: boolean;
      poi?: boolean;
      minor?: boolean;
    }
  > = filtered.map(({ userId: creatorId, cursorId, unpublishedAt, ...i }) => {
    const match = imageMetrics[i.id];
    const thumbnail = thumbnails[i.id];
    const userData = userBasicData[creatorId];

    return {
      ...i,
      meta: imageMeta?.[i.id] ?? null,
      nsfwLevel: Math.max(thumbnail?.nsfwLevel ?? 0, i.nsfwLevel),
      modelVersionIds: imageResources?.[i.id]?.resources?.map((r) => r.modelVersionId) ?? [],
      modelVersionIdsManual: [],
      publishedAt: i.publishedAt ? i.sortAt : undefined,
      baseModel: imageResources
        ? getBaseModelFromResources(imageResources[i.id]?.resources)
        : undefined,
      user: {
        id: creatorId,
        username: userData?.username ?? null,
        image: userData?.image ?? null,
        deletedAt: userData?.deletedAt ?? null,
        cosmetics: userCosmetics?.[creatorId] ?? [],
        profilePicture: profilePictures?.[creatorId] ?? null,
      },
      stats: {
        likeCountAllTime: match?.reactionLike ?? 0,
        laughCountAllTime: match?.reactionLaugh ?? 0,
        heartCountAllTime: match?.reactionHeart ?? 0,
        cryCountAllTime: match?.reactionCry ?? 0,

        commentCountAllTime: match?.comment ?? 0,
        collectedCountAllTime: match?.collection ?? 0,
        tippedAmountCountAllTime: match?.buzz ?? 0,

        dislikeCountAllTime: 0,
        viewCountAllTime: 0,
      },
      reactions:
        userReactions?.[i.id]?.map((r) => ({ userId: userId as number, reaction: r })) ?? [],
      tags: tagsVar?.filter((x) => x.imageId === i.id),
      tagIds: tagIdsVar?.[i.id]?.tags,
      cosmetic: cosmetics?.[i.id] ?? null,
      thumbnailUrl: thumbnail?.url,
    };
  });

  // Put into cached order if prioritizing user (model version showcase)
  if (prioritizeUser && useModelVersionCache) {
    images.sort((a, b) => ids!.indexOf(a.id) - ids!.indexOf(b.id));
  }

  return {
    nextCursor,
    items: images,
  };
};

// TODO split this into image-index.service because this file is a giant

const getMetaForImages = async (imageIds: number[]) => {
  if (imageIds.length === 0) return {};
  return imageMetaCache.fetch(imageIds);
};

const getMetadataForImages = async (imageIds: number[]) => {
  if (imageIds.length === 0) return {};
  return imageMetadataCache.fetch(imageIds);
};

const getThumbnailsForImages = async (imageIds: number[]) => {
  if (imageIds.length === 0) return {};
  return thumbnailCache.fetch(imageIds);
};

type GetAllImagesIndexResult = AsyncReturnType<typeof getAllImages>;
export const getAllImagesIndex = async (
  input: GetAllImagesInput
): Promise<GetAllImagesIndexResult> => {
  // const {
  //   user,
  //   limit,
  //   cursor,
  //   postIds,
  //   modelVersionId,
  //   period,
  //   include,
  //   types,
  //   fromPlatform,
  //   baseModels,
  //   tools,
  //   techniques,
  //   tags,
  //   notPublished,
  //   scheduled,
  //   withMeta: hasMeta,
  //   excludedUserIds,
  //   hideAutoResources
  //   hideManualResources
  //   hidden,
  //   followed,
  //   //
  //   prioritizedUserIds, // TODO fix
  //   modelId, // TODO fix
  //   reviewId, // TODO - remove, not in use...true?
  //   // username, // TODO - query by `userId` instead
  //   userId,
  //   collectionId, // TODO - call this from separate method?
  //   ids,
  //   skip,
  //   postId,
  //   periodMode,
  //   generation,
  //   includeBaseModel,
  //   pending,
  //   collectionTagId,
  //   headers,
  //   excludedTagIds,
  //   withTags,
  //   imageId, // TODO - remove, not in use
  //   // reactions, // we don't have reaction data
  // } = input;
  // const { sort, browsingLevel } = input;

  const { include, user } = input;

  // - cursor uses "offset|entryTimestamp" like "500|1724677401898"
  const cursorParsed = input.cursor?.toString().split('|');
  const offset = isNumber(cursorParsed?.[0]) ? Number(cursorParsed?.[0]) : 0;
  const entry = isNumber(cursorParsed?.[1]) ? Number(cursorParsed?.[1]) : undefined;

  const currentUserId = user?.id;

  const { data: searchResults, nextCursor: searchNextCursor } = await getImagesFromSearch({
    ...input,
    currentUserId,
    isModerator: user?.isModerator,
    offset,
    entry,
  });

  if (!searchResults.length) {
    return {
      nextCursor: undefined,
      items: [],
    };
  }

  const imageIds = searchResults.map((sr) => sr.id);
  const videoIds = searchResults.filter((sr) => sr.type === MediaType.video).map((sr) => sr.id);
  const userIds = searchResults.map((sr) => sr.userId);

  let userReactions: Record<number, ReviewReactions[]> | undefined;
  if (currentUserId) {
    const reactionsRaw = await dbRead.imageReaction.findMany({
      where: { imageId: { in: imageIds }, userId: currentUserId },
      select: { imageId: true, reaction: true },
    });
    userReactions = reactionsRaw.reduce((acc, { imageId, reaction }) => {
      acc[imageId] ??= [] as ReviewReactions[];
      acc[imageId].push(reaction);
      return acc;
    }, {} as Record<number, ReviewReactions[]>);
  }

  const [
    userDatas,
    profilePictures,
    userCosmetics,
    imageCosmetics,
    imageMeta,
    imageMetadata,
    thumbnails,
  ] = await Promise.all([
    await getBasicDataForUsers(userIds),
    include?.includes('profilePictures') ? await getProfilePicturesForUsers(userIds) : undefined,
    include?.includes('cosmetics') ? await getCosmeticsForUsers(userIds) : undefined,
    include?.includes('cosmetics')
      ? await getCosmeticsForEntity({
          ids: imageIds,
          entity: 'Image',
        })
      : undefined,
    include?.includes('metaSelect') ? await getMetaForImages(imageIds) : undefined,
    await getMetadataForImages(videoIds), // Only need this for videos
    await getThumbnailsForImages(videoIds), // Only need this for videos
  ]);

  const mergedData = searchResults.map(({ publishedAtUnix, ...sr }) => {
    const thisUser = userDatas[sr.userId] ?? {};
    const reactions =
      userReactions?.[sr.id]?.map((r) => ({ userId: currentUserId as number, reaction: r })) ?? [];
    const meta = imageMeta?.[sr.id]?.meta ?? null;
    const metadata = imageMetadata[sr.id]?.metadata ?? null;
    const thumbnail = thumbnails[sr.id] ?? null;
    const nsfwLevel = Math.max(thumbnail?.nsfwLevel ?? 0, sr.nsfwLevel);

    return {
      ...sr,
      modelVersionId: sr.postedToId,
      type: sr.type as MediaType,
      createdAt: sr.sortAt,
      metadata: { ...metadata, width: sr.width, height: sr.height },
      publishedAt: publishedAtUnix ? sr.sortAt : undefined,
      //
      user: {
        id: sr.userId,
        username: thisUser.username,
        image: thisUser.image,
        deletedAt: thisUser.deletedAt,
        cosmetics: userCosmetics?.[sr.userId] ?? [],
        profilePicture: profilePictures?.[sr.userId] ?? null,
      },
      reactions,
      cosmetic: imageCosmetics?.[sr.id] ?? null,
      // TODO fix below
      availability: Availability.Public,
      tags: [], // needed?
      name: null, // leave
      scannedAt: null, // remove
      mimeType: null, // need?
      ingestion:
        nsfwLevel === NsfwLevel.Blocked
          ? ImageIngestionStatus.Blocked
          : nsfwLevel === 0
          ? ImageIngestionStatus.NotFound
          : ImageIngestionStatus.Scanned, // add? maybe remove
      postTitle: null, // remove
      meta,
      nsfwLevel,
      thumbnailUrl: thumbnail?.url,
    };
  });

  let nextCursor: string | undefined;
  if (searchNextCursor) {
    nextCursor = `${offset + input.limit}|${searchNextCursor}`;
  }

  return {
    nextCursor,
    items: mergedData,
  };
};

const METRICS_SEARCH_INDEX = `${METRICS_IMAGES_SEARCH_INDEX}`;

function strArray(arr: (string | number)[]) {
  return arr.map((x) => `'${x}'`).join(',');
}

function snapToInterval(unixTimestamp: number, intervalMillisec = 60000): number {
  return Math.floor(unixTimestamp / intervalMillisec) * intervalMillisec;
}

type MeiliImageFilter = `${MetricsImageFilterableAttribute} ${string}`;
export const makeMeiliImageSearchFilter = (
  field: MetricsImageFilterableAttribute,
  criteria: string
): MeiliImageFilter => {
  return `${field} ${criteria}`;
};
type MeiliImageSort = `${MetricsImageSortableAttribute}:${'asc' | 'desc'}`;
export const makeMeiliImageSearchSort = (
  field: MetricsImageSortableAttribute,
  criteria: 'asc' | 'desc'
): MeiliImageSort => {
  return `${field}:${criteria}`;
};

type ImageSearchInput = GetInfiniteImagesOutput & {
  useCombinedNsfwLevel?: boolean;
  currentUserId?: number;
  isModerator?: boolean;
  offset?: number;
  entry?: number;
  blockedFor?: string[];
  // Unhandled
  //prioritizedUserIds?: number[];
  //userIds?: number | number[];
  //modelId?: number;
  //reviewId?: number;
};

export async function getImagesFromSearch(input: ImageSearchInput) {
  let searchFn = getImagesFromSearchPreFilter;
  const fliptClient = await FliptSingleton.getInstance();
  if (fliptClient) {
    const flag = fliptClient.evaluateBoolean({
      flagKey: FLIPT_FEATURE_FLAGS.FEED_POST_FILTER,
      entityId: input.currentUserId?.toString() || 'anonymous',
      context: {},
    });
    if (flag.enabled) searchFn = getImagesFromSearchPostFilter;
  }

  return searchFn(input);
}

export async function getImagesFromFeedSearch(
  input: ImageSearchInput
): Promise<GetAllImagesIndexResult> {
  try {
    // Evaluate feature flags before creating feed
    let enableExistenceCheck = false;
    const fliptClient = await FliptSingleton.getInstance();
    if (fliptClient) {
      try {
        const flag = fliptClient.evaluateBoolean({
          flagKey: FLIPT_FEATURE_FLAGS.FEED_IMAGE_EXISTENCE,
          entityId: input.currentUserId?.toString() || 'anonymous',
          context: {},
        });
        enableExistenceCheck = flag.enabled;
      } catch (err) {
        console.log('[getImagesFromFeedSearch] Flipt evaluation failed:', err);
      }
    }

    const feed = new ImagesFeed(
      ({ apiKey, host }) =>
        new MeiliSearch({
          host,
          apiKey,
        }) as IMeilisearch,
      clickhouse as IClickhouseClient,
      pgDbWrite as IDbClient,
      new MetricService(clickhouse as IClickhouseClient, redis as unknown as IRedisClient),
      new CacheService(
        redis as unknown as IRedisClient,
        pgDbWrite as IDbClient,
        clickhouse as IClickhouseClient
      )
    );

    // Convert cursor to string if it's not already, and add feature flag result
    const feedInput = {
      ...input,
      cursor: input.cursor ? String(input.cursor) : undefined,
      enableExistenceCheck,
    };

    const feedResult = await feed.populatedQuery(feedInput as FeedQueryInput<ImageQueryInput>);

    // Transform PopulatedImage to match getAllImagesIndex return type
    // Remove extra fields that PopulatedImage has but getAllImagesIndex doesn't
    const transformedItems: ImagesInfiniteModel[] = feedResult.items.map((img) => {
      // Destructure to remove all extra fields from PopulatedImage/ImageDocument
      // that aren't in ImagesInfiniteModel
      const {
        // Timestamp unix fields (not in ImagesInfiniteModel)
        sortAtUnix,
        publishedAtUnix,
        existedAtUnix,
        // Array fields handled differently
        tagIds,
        toolIds,
        techniqueIds,
        // Flags object (not in ImagesInfiniteModel)
        flags,
        // NSFW fields (different handling)
        aiNsfwLevel,
        combinedNsfwLevel,
        // Metric counts (stats object has these instead)
        reactionCount,
        commentCount,
        collectedCount,
        // Other fields not in ImagesInfiniteModel
        userId,
        acceptableMinor,
        // Fields that need type transformation
        reactions,
        tags,
        ...rest
      } = img;

      // Transform tags to match VotableTagModel (add missing fields with defaults)
      // Note: tag.type and tag.nsfwLevel need casting because PopulatedImage uses
      // its own type definitions from event-engine-common, while VotableTagModel
      // uses types from ~/server/common/enums
      const transformedTags: VotableTagModel[] = tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        type: tag.type as unknown as TagType,
        nsfwLevel: tag.nsfwLevel as unknown as NsfwLevel,
        score: 0,
        upVotes: 0,
        downVotes: 0,
      }));

      // Transform reactions to use ReviewReactions enum
      const transformedReactions = reactions.map((r) => ({
        userId: r.userId,
        reaction: r.reaction as ReviewReactions,
      }));

      // Return structure matching getAllImagesIndex
      return {
        ...rest,
        nsfwLevel: img.nsfwLevel as NsfwLevel,
        type: img.type as MediaType,
        availability: img.availability ?? Availability.Public,
        reactions: transformedReactions,
        tags: transformedTags,
      };
    });

    return {
      nextCursor: feedResult.nextCursor,
      items: transformedItems,
    };
  } catch (err) {
    console.error('Error in getImagesFromFeedSearch:', err);
    throw err;
  }
}

export async function getImagesFromSearchPreFilter(input: ImageSearchInput) {
  if (!metricsSearchClient) return { data: [], nextCursor: undefined };
  let { postIds = [] } = input;

  const {
    sort,
    modelVersionId,
    types,
    withMeta,
    fromPlatform,
    notPublished,
    scheduled,
    username,
    tags,
    tools,
    techniques,
    baseModels,
    period,
    isModerator,
    currentUserId,
    excludedUserIds,
    hideAutoResources,
    hideManualResources,
    hidden,
    followed,
    limit = 100,
    offset,
    entry,
    postId,
    reviewId,
    modelId,
    prioritizedUserIds,
    useCombinedNsfwLevel,
    remixOfId,
    remixesOnly,
    nonRemixesOnly,
    excludedTagIds,
    disablePoi,
    disableMinor,
    requiringMeta,
    poiOnly,
    minorOnly,
    blockedFor,
    // TODO check the unused stuff in here
  } = input;
  let { browsingLevel, userId } = input;

  const sorts: MeiliImageSort[] = [];
  const filters: string[] = [];

  if (!isModerator) {
    filters.push(
      // Avoids exposing private resources to the public
      `((NOT availability = ${Availability.Private})${
        currentUserId ? ` OR "userId" = ${currentUserId}` : ''
      })`
    );

    filters.push(
      // Avoids blocked resources to the public
      `(("blockedFor" IS NULL OR "blockedFor" NOT EXISTS)${
        currentUserId ? ` OR "userId" = ${currentUserId}` : ''
      })`
    );
  }

  if (postId) {
    postIds = [...(postIds ?? []), postId];
  }

  if (disablePoi) {
    filters.push(`(NOT poi = true${currentUserId ? ` OR "userId" = ${currentUserId}` : ''})`);
  }
  if (disableMinor) {
    filters.push(`(NOT minor = true)`);
  }

  if (isModerator) {
    if (poiOnly) {
      filters.push(`poi = true`);
    }
    if (minorOnly) {
      filters.push(`minor = true`);
    }
    if (blockedFor?.length) {
      filters.push(`blockedFor IN [${strArray(blockedFor)}]`);
    }
  }

  // Filter
  //------------------------
  if (hidden) {
    if (!currentUserId) throw throwAuthorizationError();
    const hiddenImages = await dbRead.imageEngagement.findMany({
      where: { userId: currentUserId, type: 'Hide' },
      select: { imageId: true },
    });
    const imageIds = hiddenImages.map((x) => x.imageId);
    if (imageIds.length) {
      filters.push(makeMeiliImageSearchFilter('id', `IN [${imageIds.join(',')}]`));
    } else {
      return { data: [], nextCursor: undefined };
    }
  }

  if (username && !userId) {
    const targetUser = await dbRead.user.findUnique({ where: { username }, select: { id: true } });
    if (!targetUser) throw new Error('User not found');
    userId = targetUser.id;

    logToAxiom(
      { type: 'info', message: 'Using username instead of userId' },
      'temp-search'
    ).catch();
  }

  // could throw authorization error here
  if (currentUserId && followed) {
    const followedUsers = await dbRead.userEngagement.findMany({
      where: { userId: currentUserId, type: 'Follow' },
      select: { targetUserId: true },
    });
    const userIds = followedUsers.map((x) => x.targetUserId);
    if (userIds.length) {
      filters.push(makeMeiliImageSearchFilter('userId', `IN [${userIds.join(',')}]`));
    } else {
      return { data: [], nextCursor: undefined };
    }
  }

  // nb: commenting this out while we try checking existence in the db
  // const lastExistedAt = await redis.get(REDIS_KEYS.INDEX_UPDATES.IMAGE_METRIC);
  // if (lastExistedAt) {
  //   filters.push(makeMeiliImageSearchFilter('existedAtUnix', `>= ${lastExistedAt}`));
  // }

  // NSFW Level
  if (!browsingLevel) browsingLevel = NsfwLevel.PG;
  else browsingLevel = onlySelectableLevels(browsingLevel);
  const browsingLevels = Flags.instanceToArray(browsingLevel);
  const includesNsfwContent = Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag);

  if (isModerator && includesNsfwContent) browsingLevels.push(0);

  const nsfwLevelField: MetricsImageFilterableAttribute = useCombinedNsfwLevel
    ? 'combinedNsfwLevel'
    : 'nsfwLevel';
  const nsfwFilters = [
    makeMeiliImageSearchFilter(nsfwLevelField, `IN [${browsingLevels.join(',')}]`) as string,
  ];
  const nsfwUserFilters = [makeMeiliImageSearchFilter(nsfwLevelField, `= 0`)];
  if (currentUserId)
    nsfwUserFilters.push(makeMeiliImageSearchFilter('userId', `= ${currentUserId}`));

  nsfwFilters.push(`(${nsfwUserFilters.join(' AND ')})`);
  filters.push(`(${nsfwFilters.join(' OR ')})`);

  // NSFW License Restrictions Filter
  // Filter out images with R/X/XXX NSFW levels that use restricted base models
  if (nsfwRestrictedBaseModels.length > 0) {
    const restrictedBaseModelsQuoted = nsfwRestrictedBaseModels.map((bm) => `'${bm}'`);

    // Exclude images that have BOTH restricted NSFW levels AND restricted base models
    filters.push(
      `NOT (${nsfwLevelField} IN [${nsfwBrowsingLevelsArray.join(
        ','
      )}] AND baseModel IN [${restrictedBaseModelsQuoted.join(',')}])`
    );
  }

  if (modelVersionId) {
    const versionFilters = [makeMeiliImageSearchFilter('postedToId', `= ${modelVersionId}`)];

    if (!hideAutoResources) {
      versionFilters.push(makeMeiliImageSearchFilter('modelVersionIds', `IN [${modelVersionId}]`));
    }
    if (!hideManualResources) {
      versionFilters.push(
        makeMeiliImageSearchFilter('modelVersionIdsManual', `IN [${modelVersionId}]`)
      );
    }

    filters.push(`(${versionFilters.join(' OR ')})`);
  }

  if (remixOfId) {
    filters.push(makeMeiliImageSearchFilter('remixOfId', `= ${remixOfId}`));
  }

  if (remixesOnly && !nonRemixesOnly) {
    filters.push(makeMeiliImageSearchFilter('remixOfId', '>= 0'));
  }

  if (nonRemixesOnly) {
    filters.push(makeMeiliImageSearchFilter('remixOfId', 'NOT EXISTS'));
  }

  if (excludedTagIds?.length) {
    // Needed support for this in order to properly support multiple domains.
    filters.push(makeMeiliImageSearchFilter('tagIds', `NOT IN [${excludedTagIds.join(',')}]`));
  }

  /*
  // TODO this won't work, can't do custom sort
  if (prioritizedUserIds?.length) {
    // why do this?
    // if (cursor) throw new Error('Cannot use cursor with prioritizedUserIds');

    // If system user, show community images
    if (prioritizedUserIds.length === 1 && prioritizedUserIds[0] === -1) {
      sorts.push(makeMeiliImageSearchSort('index', 'asc'))
      // orderBy = `IIF(i."userId" IN (${prioritizedUserIds.join(',')}), i.index, 1000),  ${orderBy}`
    } else {
      // For everyone else, only show their images.
      filters.push(makeMeiliImageSearchFilter('userId', `IN [${prioritizedUserIds.join(',')}]`));
      sorts.push(makeMeiliImageSearchSort('postedToId', 'asc'));
      sorts.push(makeMeiliImageSearchSort('index', 'asc'));
      // orderBy = `(i."postId" * 100) + i."index"`; // Order by oldest post first
    }
  }
  */

  if (withMeta) filters.push(makeMeiliImageSearchFilter('hasMeta', '= true'));
  if (requiringMeta) {
    filters.push(`("blockedFor" = ${BlockedReason.AiNotVerified})`);
  }
  if (fromPlatform) filters.push(makeMeiliImageSearchFilter('onSite', '= true'));

  if (isModerator) {
    if (notPublished) filters.push(makeMeiliImageSearchFilter('publishedAtUnix', 'NOT EXISTS'));
    else if (scheduled)
      filters.push(makeMeiliImageSearchFilter('publishedAtUnix', `> ${Date.now()}`));
    else {
      const publishedFilters = [makeMeiliImageSearchFilter('publishedAtUnix', `<= ${Date.now()}`)];
      if (currentUserId) {
        publishedFilters.push(makeMeiliImageSearchFilter('userId', `= ${currentUserId}`));
      }
      filters.push(`(${publishedFilters.join(' OR ')})`);
    }
  } else {
    // Users should only see published stuff or things they own
    // convert to minutes for better caching
    const publishedFilters = [
      makeMeiliImageSearchFilter('publishedAtUnix', `<= ${snapToInterval(Math.round(Date.now()))}`),
    ];
    if (currentUserId) {
      publishedFilters.push(makeMeiliImageSearchFilter('userId', `= ${currentUserId}`));
    }
    filters.push(`(${publishedFilters.join(' OR ')})`);
  }

  if (types?.length) filters.push(makeMeiliImageSearchFilter('type', `IN [${types.join(',')}]`));
  if (tags?.length) filters.push(makeMeiliImageSearchFilter('tagIds', `IN [${tags.join(',')}]`));
  if (tools?.length) filters.push(makeMeiliImageSearchFilter('toolIds', `IN [${tools.join(',')}]`));
  if (techniques?.length)
    filters.push(makeMeiliImageSearchFilter('techniqueIds', `IN [${techniques.join(',')}]`));
  if (postIds?.length)
    filters.push(makeMeiliImageSearchFilter('postId', `IN [${postIds.join(',')}]`));
  if (baseModels?.length)
    filters.push(makeMeiliImageSearchFilter('baseModel', `IN [${strArray(baseModels)}]`));

  // TODO why were we doing this at all?
  // if (userIds) {
  //   userIds = Array.isArray(userIds) ? userIds : [userIds];
  //   filters.push(makeMeiliImageSearchFilter('userId', `IN [${userIds.join(',')}]`));
  // }

  if (userId) filters.push(makeMeiliImageSearchFilter('userId', `= ${userId}`));
  else if (excludedUserIds)
    filters.push(makeMeiliImageSearchFilter('userId', `NOT IN [${excludedUserIds.join(',')}]`));

  // TODO.metricSearch if reviewId, get corresponding userId instead and add to userIds before making this request
  //  how?
  // if (reviewId) {}

  // Handle period filter
  let afterDate: Date | undefined;
  if (period && period !== 'AllTime') {
    const now = dayjs();
    afterDate = now.subtract(1, period.toLowerCase() as ManipulateType).toDate();
  }
  if (afterDate) {
    // convert to minutes for better caching
    filters.push(
      makeMeiliImageSearchFilter(
        'sortAtUnix',
        `> ${snapToInterval(Math.round(afterDate.getTime()))}`
      )
    );
  }

  // nb: this is for dev 08-19
  // if (!isProd) {
  // filters.push(makeMeiliImageSearchFilter('id', '<= 25147444'));
  // }

  // TODO log more of these
  // Log properties we don't support yet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cantProcess: Record<string, any> = {
    reviewId,
    modelId,
    prioritizedUserIds,
  };
  if (reviewId || modelId || prioritizedUserIds) {
    const missingKeys = Object.keys(cantProcess).filter((key) => cantProcess[key] !== undefined);
    logToAxiom({ type: 'info', input: JSON.stringify(missingKeys) }, 'temp-search').catch();
  }

  // Sort
  //------------------------

  let searchSort: MeiliImageSort;
  if (sort === ImageSort.MostComments) {
    searchSort = makeMeiliImageSearchSort('commentCount', 'desc');
  } else if (sort === ImageSort.MostReactions) {
    searchSort = makeMeiliImageSearchSort('reactionCount', 'desc');
  } else if (sort === ImageSort.MostCollected) {
    searchSort = makeMeiliImageSearchSort('collectedCount', 'desc');
  } else if (sort === ImageSort.Oldest) {
    searchSort = makeMeiliImageSearchSort('sortAt', 'asc');
  } else {
    searchSort = makeMeiliImageSearchSort('sortAt', 'desc');
    // - to avoid dupes (for any ascending query), we need to filter on that attribute
    if (entry) {
      // Note: this could cause posts to be missed/included in multiple pages due to the minute rounding
      filters.push(
        makeMeiliImageSearchFilter('sortAtUnix', `<= ${snapToInterval(Math.round(entry))}`)
      );
    }
  }
  sorts.push(searchSort);
  //sorts.push(makeMeiliImageSearchSort('id', 'desc')); // secondary sort for consistency

  const request: SearchParams = {
    filter: filters.join(' AND '),
    sort: sorts,
    limit: limit + 1,
    offset,
  };

  const route = 'getImagesFromSearch';
  const endTimer = requestDurationSeconds.startTimer({ route });
  requestTotal.inc({ route }); // count every request up front

  try {
    const { results } = await metricsSearchClient
      .index(METRICS_SEARCH_INDEX)
      .getDocuments<ImageMetricsSearchIndexRecord>(request);

    let nextCursor: number | undefined;
    if (results.length > limit) {
      results.pop();
      // - if we have no entrypoint, it's the first request, and set one for the future
      //   else keep it the same
      nextCursor = !entry ? results[0]?.sortAtUnix : entry;
    }

    const filteredHits = results.filter((hit) => {
      if (!hit.url)
        // check for good data
        return false;
      // filter out items flagged with minor unless it's the owner or moderator
      if (hit.acceptableMinor) return hit.userId === currentUserId || isModerator;
      // filter out non-scanned unless it's the owner or moderator
      if (![0, NsfwLevel.Blocked].includes(hit.nsfwLevel) && !hit.needsReview) return true;

      return hit.userId === currentUserId || (isModerator && includesNsfwContent);
    });

    // Get all image IDs from search results
    const searchImageIds = filteredHits.map((hit) => hit.id);
    const filteredHitIds = [...new Set(searchImageIds)];

    let cacheExistenceEnabled = false;

    const fliptClient = await FliptSingleton.getInstance();
    if (fliptClient) {
      const flag = fliptClient.evaluateBoolean({
        flagKey: FLIPT_FEATURE_FLAGS.FEED_IMAGE_EXISTENCE,
        entityId: currentUserId?.toString() || 'anonymous',
        context: {},
      });
      cacheExistenceEnabled = flag.enabled;
    }
    ffRequestsTotal.inc({ route, enabled: String(cacheExistenceEnabled) });

    if (!cacheExistenceEnabled) {
      cacheHitRequestsTotal.inc({ route, hit_type: 'miss' });

      // BASIC DB CHECK (default)
      const dbIdResp = await dbRead.image.findMany({
        where: { id: { in: filteredHitIds } },
        select: { id: true },
      });

      const idSet = new Set(dbIdResp.map((r) => r.id));
      const filtered = results.filter((h) => idSet.has(h.id));

      const droppedCount = results.length - filtered.length;
      droppedIdsTotal.inc({ route, hit_type: 'miss' }, droppedCount);

      const imageMetrics = await getImageMetricsObject(filtered);
      const fullData = filtered.map((h) => {
        const match = imageMetrics[h.id];
        return {
          ...h,
          stats: {
            likeCountAllTime: match?.reactionLike ?? 0,
            laughCountAllTime: match?.reactionLaugh ?? 0,
            heartCountAllTime: match?.reactionHeart ?? 0,
            cryCountAllTime: match?.reactionCry ?? 0,
            commentCountAllTime: match?.comment ?? 0,
            collectedCountAllTime: match?.collection ?? 0,
            tippedAmountCountAllTime: match?.buzz ?? 0,
            dislikeCountAllTime: 0,
            viewCountAllTime: 0,
          },
        };
      });

      endTimer();

      return { data: fullData, nextCursor };
    }

    // ===== SMART CACHE EXISTENCE CHECK (feature-flagged) =====
    const checkImageExistence = async (imageIds: number[]) => {
      // Preserve original order and remove duplicates
      const uniqueIds = [...new Set(imageIds)];
      const cachePrefix = `${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:`;
      const cacheKeys = uniqueIds.map((id) => `${cachePrefix}${id}` as RedisKeyTemplateSys);

      // Check cached results first (1 minute TTL)
      const cachedResults = await sysRedis.packed.mGet(cacheKeys);

      // Separate cached and uncached IDs
      const uncachedIds: number[] = [];
      const cachedMap = new Map<number, boolean>();
      let cacheMiss = 0;

      for (let i = 0; i < uniqueIds.length; i++) {
        const id = uniqueIds[i];
        const cachedResult = cachedResults[i];

        if (cachedResult === 'true') {
          cachedMap.set(id, true);
        } else if (cachedResult === 'false') {
          cachedMap.set(id, false);
        } else {
          uncachedIds.push(id);
          cacheMiss++;
        }
      }

      let hitType: 'full' | 'partial' | 'miss';
      if (cacheMiss === 0) {
        hitType = 'full';
      } else if (cacheMiss === uniqueIds.length) {
        hitType = 'miss';
      } else {
        hitType = 'partial';
      }

      cacheHitRequestsTotal.inc({ route, hit_type: hitType });

      // Query DB for uncached IDs
      if (uncachedIds.length > 0) {
        const dbResults = await dbRead.image.findMany({
          where: { id: { in: uncachedIds } },
          select: { id: true },
        });

        const dbIdSet = new Set(dbResults.map((r) => r.id));

        // Update cache with DB results (1-minute TTL)
        const cacheUpdates: Record<string, string> = {};
        for (const id of uncachedIds) {
          const exists = dbIdSet.has(id);
          cacheUpdates[`${cachePrefix}${id}`] = exists ? 'true' : 'false';
          cachedMap.set(id, exists);
        }

        await Promise.all(
          Object.entries(cacheUpdates).map(([key, value]) =>
            sysRedis.packed.set(key as RedisKeyTemplateSys, value, { EX: 600 })
          )
        );
      }

      // Filter hits based on existence check while preserving order
      let dropped = 0;
      const filteredHits = results.filter((hit) => {
        const exists = cachedMap.get(hit.id);
        const keep = exists !== false; // treat undefined as exists=true
        if (!keep) dropped++;

        return keep;
      });

      droppedIdsTotal.inc({ route, hit_type: hitType }, dropped);

      return filteredHits.filter((x) => imageIds.includes(x.id));
    };

    // Apply the (flagged) existence check
    const filtered = await checkImageExistence(filteredHitIds);

    const imageMetrics = await getImageMetricsObject(filtered);

    const fullData = filtered.map((h) => {
      const match = imageMetrics[h.id];
      return {
        ...h,
        stats: {
          likeCountAllTime: match?.reactionLike ?? 0,
          laughCountAllTime: match?.reactionLaugh ?? 0,
          heartCountAllTime: match?.reactionHeart ?? 0,
          cryCountAllTime: match?.reactionCry ?? 0,
          commentCountAllTime: match?.comment ?? 0,
          collectedCountAllTime: match?.collection ?? 0,
          tippedAmountCountAllTime: match?.buzz ?? 0,
          dislikeCountAllTime: 0,
          viewCountAllTime: 0,
        },
      };
    });

    endTimer();
    return {
      data: fullData,
      nextCursor,
    };
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
    ).catch();

    endTimer();
    return { data: [], nextCursor: undefined };
  }
}

export async function getImagesFromSearchPostFilter(input: ImageSearchInput) {
  if (!metricsSearchClient) return { data: [], nextCursor: undefined };
  let { postIds = [] } = input;

  const {
    sort,
    modelVersionId,
    types,
    withMeta,
    fromPlatform,
    notPublished,
    scheduled,
    username,
    tags,
    tools,
    techniques,
    baseModels,
    period,
    isModerator,
    currentUserId,
    excludedUserIds,
    hideAutoResources,
    hideManualResources,
    hidden,
    followed,
    limit = 100,
    offset,
    entry,
    postId,
    reviewId,
    modelId,
    prioritizedUserIds,
    useCombinedNsfwLevel,
    remixOfId,
    remixesOnly,
    nonRemixesOnly,
    excludedTagIds,
    disablePoi,
    disableMinor,
    requiringMeta,
    poiOnly,
    minorOnly,
    blockedFor,
    // TODO check the unused stuff in here
  } = input;
  let { browsingLevel, userId } = input;

  const sorts: MeiliImageSort[] = [];
  const filters: string[] = [];

  if (postId) {
    postIds = [...(postIds ?? []), postId];
  }

  // Past POI cut-off, don't even return for owners
  if (disablePoi) {
    filters.push(`(NOT poi = true)`);
  }
  if (disableMinor) {
    filters.push(`(NOT minor = true)`);
  }

  if (isModerator) {
    if (poiOnly) {
      filters.push(`poi = true`);
    }
    if (minorOnly) {
      filters.push(`minor = true`);
    }
    if (blockedFor?.length) {
      filters.push(`blockedFor IN [${strArray(blockedFor)}]`);
    }
  }

  // Filter
  //------------------------
  if (hidden) {
    if (!currentUserId) throw throwAuthorizationError();
    const hiddenImages = await dbRead.imageEngagement.findMany({
      where: { userId: currentUserId, type: 'Hide' },
      select: { imageId: true },
    });
    const imageIds = hiddenImages.map((x) => x.imageId);
    if (imageIds.length) {
      filters.push(makeMeiliImageSearchFilter('id', `IN [${imageIds.join(',')}]`));
    } else {
      return { data: [], nextCursor: undefined };
    }
  }

  if (username && !userId) {
    const targetUser = await dbRead.user.findUnique({ where: { username }, select: { id: true } });
    if (!targetUser) throw new Error('User not found');
    userId = targetUser.id;

    logToAxiom(
      { type: 'info', message: 'Using username instead of userId' },
      'temp-search'
    ).catch();
  }

  // could throw authorization error here
  if (currentUserId && followed) {
    const followedUsers = await dbRead.userEngagement.findMany({
      where: { userId: currentUserId, type: 'Follow' },
      select: { targetUserId: true },
    });
    const userIds = followedUsers.map((x) => x.targetUserId);
    if (userIds.length) {
      filters.push(makeMeiliImageSearchFilter('userId', `IN [${userIds.join(',')}]`));
    } else {
      return { data: [], nextCursor: undefined };
    }
  }

  // nb: commenting this out while we try checking existence in the db
  // const lastExistedAt = await redis.get(REDIS_KEYS.INDEX_UPDATES.IMAGE_METRIC);
  // if (lastExistedAt) {
  //   filters.push(makeMeiliImageSearchFilter('existedAtUnix', `>= ${lastExistedAt}`));
  // }

  // NSFW Level
  if (!browsingLevel) browsingLevel = NsfwLevel.PG;
  else browsingLevel = onlySelectableLevels(browsingLevel);
  const browsingLevels = Flags.instanceToArray(browsingLevel);
  const includesNsfwContent = Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag);

  if (isModerator && includesNsfwContent) browsingLevels.push(0);

  const nsfwLevelField: MetricsImageFilterableAttribute = useCombinedNsfwLevel
    ? 'combinedNsfwLevel'
    : 'nsfwLevel';
  const nsfwFilters = [
    makeMeiliImageSearchFilter(nsfwLevelField, `IN [${browsingLevels.join(',')}]`) as string,
  ];
  // Allow users to see their own unscanned content on their user page
  if (currentUserId && userId === currentUserId)
    nsfwFilters.push(makeMeiliImageSearchFilter(nsfwLevelField, `= 0`));

  filters.push(`(${nsfwFilters.join(' OR ')})`);

  // NSFW License Restrictions Filter
  // Filter out images with R/X/XXX NSFW levels that use restricted base models
  if (nsfwRestrictedBaseModels.length > 0) {
    const restrictedBaseModelsQuoted = nsfwRestrictedBaseModels.map((bm) => `'${bm}'`);

    // Exclude images that have BOTH restricted NSFW levels AND restricted base models
    filters.push(
      `NOT (${nsfwLevelField} IN [${nsfwBrowsingLevelsArray.join(
        ','
      )}] AND baseModel IN [${restrictedBaseModelsQuoted.join(',')}])`
    );
  }

  if (modelVersionId) {
    const versionFilters = [makeMeiliImageSearchFilter('postedToId', `= ${modelVersionId}`)];

    if (!hideAutoResources) {
      versionFilters.push(makeMeiliImageSearchFilter('modelVersionIds', `IN [${modelVersionId}]`));
    }
    if (!hideManualResources) {
      versionFilters.push(
        makeMeiliImageSearchFilter('modelVersionIdsManual', `IN [${modelVersionId}]`)
      );
    }

    filters.push(`(${versionFilters.join(' OR ')})`);
  }

  if (remixOfId) {
    filters.push(makeMeiliImageSearchFilter('remixOfId', `= ${remixOfId}`));
  }

  if (remixesOnly && !nonRemixesOnly) {
    filters.push(makeMeiliImageSearchFilter('remixOfId', '>= 0'));
  }

  if (nonRemixesOnly) {
    filters.push(makeMeiliImageSearchFilter('remixOfId', 'NOT EXISTS'));
  }

  if (excludedTagIds?.length) {
    // Needed support for this in order to properly support multiple domains.
    filters.push(makeMeiliImageSearchFilter('tagIds', `NOT IN [${excludedTagIds.join(',')}]`));
  }

  /*
  // TODO this won't work, can't do custom sort
  if (prioritizedUserIds?.length) {
    // why do this?
    // if (cursor) throw new Error('Cannot use cursor with prioritizedUserIds');

    // If system user, show community images
    if (prioritizedUserIds.length === 1 && prioritizedUserIds[0] === -1) {
      sorts.push(makeMeiliImageSearchSort('index', 'asc'))
      // orderBy = `IIF(i."userId" IN (${prioritizedUserIds.join(',')}), i.index, 1000),  ${orderBy}`
    } else {
      // For everyone else, only show their images.
      filters.push(makeMeiliImageSearchFilter('userId', `IN [${prioritizedUserIds.join(',')}]`));
      sorts.push(makeMeiliImageSearchSort('postedToId', 'asc'));
      sorts.push(makeMeiliImageSearchSort('index', 'asc'));
      // orderBy = `(i."postId" * 100) + i."index"`; // Order by oldest post first
    }
  }
  */

  if (withMeta) filters.push(makeMeiliImageSearchFilter('hasMeta', '= true'));
  if (requiringMeta) {
    filters.push(`("blockedFor" = ${BlockedReason.AiNotVerified})`);
  }
  if (fromPlatform) filters.push(makeMeiliImageSearchFilter('onSite', '= true'));

  // Publish Date Filtering
  const snappedNow = snapToInterval(Date.now());
  if (isModerator) {
    if (notPublished) filters.push(makeMeiliImageSearchFilter('publishedAtUnix', 'NOT EXISTS'));
    else if (scheduled)
      filters.push(makeMeiliImageSearchFilter('publishedAtUnix', `> ${Date.now()}`));
    else {
      const publishedFilters = [makeMeiliImageSearchFilter('publishedAtUnix', `<= ${Date.now()}`)];
      if (currentUserId) {
        publishedFilters.push(makeMeiliImageSearchFilter('userId', `= ${currentUserId}`));
      }
      filters.push(`(${publishedFilters.join(' OR ')})`);
    }
  } else if (userId) {
    const publishedFilters = [makeMeiliImageSearchFilter('publishedAtUnix', `<= ${Date.now()}`)];
    // For own user's content, allow seeing scheduled/notPublished content
    if (currentUserId && userId === currentUserId) {
      publishedFilters.push(makeMeiliImageSearchFilter('userId', `= ${currentUserId}`));
    }
    filters.push(`(${publishedFilters.join(' OR ')})`);
  } else {
    // General feed queries - apply published filter for caching
    filters.push(makeMeiliImageSearchFilter('publishedAtUnix', `<= ${snappedNow}`));
  }

  if (types?.length) filters.push(makeMeiliImageSearchFilter('type', `IN [${types.join(',')}]`));
  if (tags?.length) filters.push(makeMeiliImageSearchFilter('tagIds', `IN [${tags.join(',')}]`));
  if (tools?.length) filters.push(makeMeiliImageSearchFilter('toolIds', `IN [${tools.join(',')}]`));
  if (techniques?.length)
    filters.push(makeMeiliImageSearchFilter('techniqueIds', `IN [${techniques.join(',')}]`));
  if (postIds?.length)
    filters.push(makeMeiliImageSearchFilter('postId', `IN [${postIds.join(',')}]`));
  if (baseModels?.length)
    filters.push(makeMeiliImageSearchFilter('baseModel', `IN [${strArray(baseModels)}]`));

  // TODO why were we doing this at all?
  // if (userIds) {
  //   userIds = Array.isArray(userIds) ? userIds : [userIds];
  //   filters.push(makeMeiliImageSearchFilter('userId', `IN [${userIds.join(',')}]`));
  // }

  if (userId) filters.push(makeMeiliImageSearchFilter('userId', `= ${userId}`));
  else if (excludedUserIds)
    filters.push(makeMeiliImageSearchFilter('userId', `NOT IN [${excludedUserIds.join(',')}]`));

  // TODO.metricSearch if reviewId, get corresponding userId instead and add to userIds before making this request
  //  how?
  // if (reviewId) {}

  // Handle period filter
  let afterDate: Date | undefined;
  if (period && period !== 'AllTime') {
    const now = dayjs();
    afterDate = now.subtract(1, period.toLowerCase() as ManipulateType).toDate();
  }
  if (afterDate) {
    // convert to minutes for better caching
    filters.push(
      makeMeiliImageSearchFilter('sortAtUnix', `> ${snapToInterval(afterDate.getTime())}`)
    );
  }

  // nb: this is for dev 08-19
  // if (!isProd) {
  // filters.push(makeMeiliImageSearchFilter('id', '<= 25147444'));
  // }

  // TODO log more of these
  // Log properties we don't support yet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cantProcess: Record<string, any> = {
    reviewId,
    modelId,
    prioritizedUserIds,
  };
  if (reviewId || modelId || prioritizedUserIds) {
    const missingKeys = Object.keys(cantProcess).filter((key) => cantProcess[key] !== undefined);
    logToAxiom({ type: 'info', input: JSON.stringify(missingKeys) }, 'temp-search').catch();
  }

  // Sort
  //------------------------

  let searchSort: MeiliImageSort;
  if (sort === ImageSort.MostComments) {
    searchSort = makeMeiliImageSearchSort('commentCount', 'desc');
  } else if (sort === ImageSort.MostReactions) {
    searchSort = makeMeiliImageSearchSort('reactionCount', 'desc');
  } else if (sort === ImageSort.MostCollected) {
    searchSort = makeMeiliImageSearchSort('collectedCount', 'desc');
  } else if (sort === ImageSort.Oldest) {
    searchSort = makeMeiliImageSearchSort('sortAt', 'asc');
  } else {
    searchSort = makeMeiliImageSearchSort('sortAt', 'desc');
  }
  sorts.push(searchSort);
  //sorts.push(makeMeiliImageSearchSort('id', 'desc')); // secondary sort for consistency

  const route = 'getImagesFromSearch';
  const endTimer = requestDurationSeconds.startTimer({ route });
  requestTotal.inc({ route }); // count every request up front

  // Iterative fetching with adaptive batch sizing to handle post-filtering
  const MAX_ITERATIONS = 10;
  const MAX_TOTAL_PROCESSED = limit * 100; // Safety limit to prevent excessive processing
  const MIN_BATCH_SIZE = limit * 2;
  const MAX_BATCH_SIZE = limit * 10;

  const accumulatedHits: ImageMetricsSearchIndexRecord[] = [];
  let currentOffset = offset || 0;
  let batchSize = MIN_BATCH_SIZE;
  let iteration = 0;
  let totalProcessed = 0;
  let nextCursor: number | undefined;
  const request: SearchParams = {
    filter: filters.join(' AND '),
    sort: sorts,
  };

  try {
    while (accumulatedHits.length < limit + 1 && iteration < MAX_ITERATIONS) {
      // Safety check for total processed results
      if (totalProcessed >= MAX_TOTAL_PROCESSED) {
        break;
      }

      const requestLimit = Math.min(batchSize, MAX_TOTAL_PROCESSED - totalProcessed);
      request.limit = requestLimit;
      request.offset = currentOffset;

      const { results } = await metricsSearchClient
        .index(METRICS_SEARCH_INDEX)
        .getDocuments<ImageMetricsSearchIndexRecord>(request);

      // If no more results, break the loop
      if (results.length === 0) {
        break;
      }

      // Apply post-query user-specific filtering
      const batchFilteredHits = results.filter((hit) => {
        if (!hit.url)
          // check for good data
          return false;

        const isOwnContent = (currentUserId && hit.userId === currentUserId) || isModerator;

        // User can see their own private content
        if (hit.availability === Availability.Private && !isOwnContent) return false;

        // User can see their own blocked content
        if (hit.blockedFor && !isOwnContent) return false;

        // User can see their own scheduled or unpublished content
        if (
          (!hit.publishedAtUnix || hit.publishedAtUnix > snappedNow) &&
          (!isOwnContent || notPublished === false)
        )
          return false;

        // User can see their own unscanned content
        if (hit.nsfwLevel === 0 && !isOwnContent) return false;

        // filter out items flagged with minor unless it's the owner or moderator
        if (hit.acceptableMinor) return isOwnContent;
        // filter out non-scanned unless it's the owner or moderator
        if (![0, NsfwLevel.Blocked].includes(hit.nsfwLevel) && !hit.needsReview) return true;

        return isOwnContent || (isModerator && includesNsfwContent);
      });

      // Add filtered results to accumulated results
      accumulatedHits.push(...batchFilteredHits);

      // Calculate filter ratio and adjust batch size for next iteration
      const filterRatio = results.length > 0 ? 1 - batchFilteredHits.length / results.length : 0;

      // If more than 80% of results are filtered out, increase batch size
      if (filterRatio > 0.8 && batchSize < MAX_BATCH_SIZE) {
        batchSize = Math.min(Math.ceil(batchSize * 1.5), MAX_BATCH_SIZE);
      }

      // Update tracking variables
      currentOffset += results.length;
      totalProcessed += results.length;
      iteration++;

      // If we got fewer results than what we actually requested, we've likely hit the end
      if (results.length < requestLimit) {
        break;
      }
    }

    // Update nextCursor based on whether we have more results than requested
    if (accumulatedHits.length > limit) {
      // We have more results, so there's a next page
      const lastResult = accumulatedHits[limit];
      nextCursor = lastResult?.sortAtUnix || nextCursor;
    } else {
      // We don't have more results than requested, so no next page
      nextCursor = undefined;
    }

    // Trim results back to requested limit after filtering
    const limitedHits = accumulatedHits.slice(0, limit + 1);

    // Get all image IDs from limited results
    const searchImageIds = limitedHits.map((hit) => hit.id);
    const filteredHitIds = [...new Set(searchImageIds)];

    let cacheExistenceEnabled = false;

    const fliptClient = await FliptSingleton.getInstance();
    if (fliptClient) {
      const flag = fliptClient.evaluateBoolean({
        flagKey: FLIPT_FEATURE_FLAGS.FEED_IMAGE_EXISTENCE,
        entityId: currentUserId?.toString() || 'anonymous',
        context: {},
      });
      cacheExistenceEnabled = flag.enabled;
    }
    ffRequestsTotal.inc({ route, enabled: String(cacheExistenceEnabled) });

    if (!cacheExistenceEnabled) {
      cacheHitRequestsTotal.inc({ route, hit_type: 'miss' });

      // BASIC DB CHECK (default)
      const dbIdResp = await dbRead.image.findMany({
        where: { id: { in: filteredHitIds } },
        select: { id: true },
      });

      const idSet = new Set(dbIdResp.map((r) => r.id));
      const filtered = limitedHits.filter((h) => idSet.has(h.id));

      if (limitedHits.length > limit) {
        const lastItem = filtered.pop();
        nextCursor = lastItem?.sortAtUnix;
      } else {
        nextCursor = undefined;
      }

      const droppedCount = limitedHits.length - filtered.length;
      droppedIdsTotal.inc({ route, hit_type: 'miss' }, droppedCount);

      const imageMetrics = await getImageMetricsObject(filtered);
      const fullData = filtered.map((h) => {
        const match = imageMetrics[h.id];
        return {
          ...h,
          stats: {
            likeCountAllTime: match?.reactionLike ?? 0,
            laughCountAllTime: match?.reactionLaugh ?? 0,
            heartCountAllTime: match?.reactionHeart ?? 0,
            cryCountAllTime: match?.reactionCry ?? 0,
            commentCountAllTime: match?.comment ?? 0,
            collectedCountAllTime: match?.collection ?? 0,
            tippedAmountCountAllTime: match?.buzz ?? 0,
            dislikeCountAllTime: 0,
            viewCountAllTime: 0,
          },
        };
      });

      endTimer();

      return { data: fullData, nextCursor };
    }

    // ===== SMART CACHE EXISTENCE CHECK (feature-flagged) =====
    const checkImageExistence = async (imageIds: number[]) => {
      // Preserve original order and remove duplicates
      const uniqueIds = [...new Set(imageIds)];
      const cachePrefix = `${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:`;
      const cacheKeys = uniqueIds.map((id) => `${cachePrefix}${id}` as RedisKeyTemplateSys);

      // Check cached results first (1 minute TTL)
      const cachedResults = cacheKeys.length > 0 ? await sysRedis.packed.mGet(cacheKeys) : [];

      // Separate cached and uncached IDs
      const uncachedIds: number[] = [];
      const cachedMap = new Map<number, boolean>();
      let cacheMiss = 0;

      for (let i = 0; i < uniqueIds.length; i++) {
        const id = uniqueIds[i];
        const cachedResult = cachedResults[i];

        if (cachedResult === 'true') {
          cachedMap.set(id, true);
        } else if (cachedResult === 'false') {
          cachedMap.set(id, false);
        } else {
          uncachedIds.push(id);
          cacheMiss++;
        }
      }

      let hitType: 'full' | 'partial' | 'miss';
      if (cacheMiss === 0) {
        hitType = 'full';
      } else if (cacheMiss === uniqueIds.length) {
        hitType = 'miss';
      } else {
        hitType = 'partial';
      }

      cacheHitRequestsTotal.inc({ route, hit_type: hitType });

      // Query DB for uncached IDs
      if (uncachedIds.length > 0) {
        const dbResults = await dbRead.image.findMany({
          where: { id: { in: uncachedIds } },
          select: { id: true },
        });

        const dbIdSet = new Set(dbResults.map((r) => r.id));

        // Update cache with DB results (1-minute TTL)
        const cacheUpdates: Record<string, string> = {};
        for (const id of uncachedIds) {
          const exists = dbIdSet.has(id);
          cacheUpdates[`${cachePrefix}${id}`] = exists ? 'true' : 'false';
          cachedMap.set(id, exists);
        }

        await Promise.all(
          Object.entries(cacheUpdates).map(([key, value]) =>
            sysRedis.packed.set(key as RedisKeyTemplateSys, value, { EX: 600 })
          )
        );
      }

      // Filter hits based on existence check while preserving order
      let dropped = 0;
      const existenceFiltered = limitedHits.filter((hit) => {
        const exists = cachedMap.get(hit.id);
        const keep = exists !== false; // treat undefined as exists=true
        if (!keep) dropped++;

        return keep;
      });

      droppedIdsTotal.inc({ route, hit_type: hitType }, dropped);

      return existenceFiltered.filter((x) => imageIds.includes(x.id));
    };

    // Apply the (flagged) existence check
    const filtered = await checkImageExistence(filteredHitIds);
    if (limitedHits.length > limit) {
      const lastItem = filtered.pop();
      nextCursor = lastItem?.sortAtUnix;
    } else {
      nextCursor = undefined;
    }

    const imageMetrics = await getImageMetricsObject(filtered);

    const fullData = filtered.map((h) => {
      const match = imageMetrics[h.id];
      return {
        ...h,
        stats: {
          likeCountAllTime: match?.reactionLike ?? 0,
          laughCountAllTime: match?.reactionLaugh ?? 0,
          heartCountAllTime: match?.reactionHeart ?? 0,
          cryCountAllTime: match?.reactionCry ?? 0,
          commentCountAllTime: match?.comment ?? 0,
          collectedCountAllTime: match?.collection ?? 0,
          tippedAmountCountAllTime: match?.buzz ?? 0,
          dislikeCountAllTime: 0,
          viewCountAllTime: 0,
        },
      };
    });

    endTimer();

    return { data: fullData, nextCursor };
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
    ).catch();
    endTimer();

    return { data: [], nextCursor: undefined };
  }
}

const getImageMetricsObject = async (data: { id: number }[]) => {
  try {
    return await imageMetricsCache.fetch(data.map((d) => d.id));
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to getImageMetrics',
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'clickhouse'
    ).catch();
    return {};
  }
};

export async function getTagNamesForImages(imageIds: number[]) {
  const tagIds = await tagIdsForImagesCache.fetch(imageIds);
  const tags = await tagCache.fetch(Object.values(tagIds).flatMap((x) => x.tags));
  const imageTags = Object.fromEntries(
    Object.entries(tagIds).map(([k, v]) => [k, v.tags.map((t) => tags[t]?.name).filter(isDefined)])
  ) as Record<number, string[]>;
  return imageTags;
}

export async function getResourceIdsForImages(imageIds: number[]) {
  const imageResourcesArr = await dbRead.$queryRaw<{ imageId: number; modelVersionId: number }[]>`
    SELECT "imageId", "modelVersionId"
    FROM "ImageResourceNew"
    WHERE "imageId" IN (${Prisma.join(imageIds)});
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
  // User fields from JOIN (not in GetAllImagesRaw since main query uses cache)
  username: string | null;
  userImage: string | null;
  deletedAt: Date | null;
};
export const getImage = async ({
  id,
  userId,
  isModerator,
  withoutPost,
}: GetImageInput & { userId?: number; isModerator?: boolean }) => {
  const AND = [Prisma.sql`i.id = ${id}`];
  if (!isModerator) {
    AND.push(
      Prisma.sql`(${Prisma.join(
        [
          Prisma.sql`i."needsReview" IS NULL AND i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
          withoutPost
            ? null
            : Prisma.sql`
              p."collectionId" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "CollectionContributor" cc
                WHERE cc."collectionId" = p."collectionId"
                  AND cc."userId" = ${userId}
                  AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
              )`,
          Prisma.sql`i."userId" = ${userId}`,
        ].filter(isDefined),
        ' OR '
      )})`
    );

    if (!withoutPost) {
      AND.push(Prisma.sql`(p."availability" != 'Private' OR p."userId" = ${userId})`);
    }
  }

  const engines = Object.keys(videoGenerationConfig2);
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
      i."createdAt",
      i."mimeType",
      i."scannedAt",
      i."needsReview",
      i."postId",
      i.ingestion,
      i."blockedFor",
      i.type,
      i.metadata,
      i."nsfwLevel",
      i.minor,
      i.poi,
      i."acceptableMinor",
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            AND i.meta->>'prompt' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) AS "hasPositivePrompt",
      (
        CASE
          WHEN (i.meta->>'civitaiResources' IS NOT NULL AND NOT (i.meta ? 'Version'))
            OR i.meta->>'engine' IS NOT NULL AND i.meta->>'engine' = ANY(ARRAY[
              ${Prisma.join(engines)}
            ]::text[])
          THEN TRUE
          ELSE FALSE
        END
      ) as "onSite",
      i."meta"->'extra'->'remixOfId' as "remixOfId",
      u.id as "userId",
      u.username,
      u.image as "userImage",
      u."deletedAt",
      u."profilePictureId",
      ${
        !withoutPost
          ? Prisma.sql`
            p."availability" "availability",
            GREATEST(p."publishedAt", i."scannedAt", i."createdAt") "publishedAt",
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
            !isModerator
              ? `AND (p."publishedAt" < now()${userId ? ` OR p."userId" = ${userId}` : ''})`
              : ''
          }`
    )}
    WHERE ${Prisma.join(AND, ' AND ')}
  `;
  if (!rawImages.length) throw throwNotFoundError(`No image with id ${id}`);

  const [{ userId: creatorId, username, userImage, deletedAt, reactions, ...firstRawImage }] =
    rawImages;

  const userCosmetics = await getCosmeticsForUsers([creatorId]);
  const profilePictures = await getProfilePicturesForUsers([creatorId]);

  const imageMetrics = await getImageMetricsObject([firstRawImage]);
  const match = imageMetrics[firstRawImage.id];
  const imageCosmetics = await getCosmeticsForEntity({
    ids: [firstRawImage.id],
    entity: 'Image',
  });

  const image = {
    ...firstRawImage,
    cosmetic: imageCosmetics?.[firstRawImage.id] ?? null,
    user: {
      id: creatorId,
      username,
      image: userImage,
      deletedAt,
      cosmetics: userCosmetics?.[creatorId] ?? [],
      profilePicture: profilePictures?.[creatorId] ?? null,
    },
    stats: {
      likeCountAllTime: match?.reactionLike ?? 0,
      laughCountAllTime: match?.reactionLaugh ?? 0,
      heartCountAllTime: match?.reactionHeart ?? 0,
      cryCountAllTime: match?.reactionCry ?? 0,

      commentCountAllTime: match?.comment ?? 0,
      collectedCountAllTime: match?.collection ?? 0,
      tippedAmountCountAllTime: match?.buzz ?? 0,

      dislikeCountAllTime: 0,
      viewCountAllTime: 0,
    },
    reactions: userId ? reactions?.map((r) => ({ userId, reaction: r })) ?? [] : [],
  };

  return image;
};

export const getImageResources = async ({ id }: GetByIdInput) => {
  const resources = await dbRead.$queryRaw<ImageResourceHelperModel[]>`
    SELECT
      irh."imageId",
      irh."reviewId",
      irh."reviewRating",
      irh."reviewDetails",
      irh."reviewCreatedAt",
      irh."name",
      irh."modelVersionId",
      irh."modelVersionName",
      irh."modelVersionCreatedAt",
      irh."modelId",
      irh."modelName",
      irh."modelThumbsUpCount",
      irh."modelThumbsDownCount",
      irh."modelDownloadCount",
      irh."modelCommentCount",
      irh."modelType",
      irh."modelVersionBaseModel",
      irh."detected"
    FROM
      "ImageResourceHelper" irh
    JOIN "Model" m ON m.id = irh."modelId" AND m."status" = 'Published'
    WHERE
      irh."imageId" = ${Prisma.sql`${id}`}
    AND irh."modelVersionId" IS NOT NULL
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
  metadata: ImageMetadata | VideoMetadata | null;
  tags?: number[];
  availability: Availability;
  sizeKB?: number;
  onSite: boolean;
  hasMeta: boolean;
  remixOfId?: number | null;
  hasPositivePrompt?: boolean;
  poi?: boolean;
  minor?: boolean;
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
          Prisma.sql`NOT EXISTS (SELECT 1 FROM "TagsOnImageDetails" toi WHERE toi."imageId" = i.id AND toi."disabled" = FALSE AND toi."tagId" IN (${Prisma.join(
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
    imageWhere.push(Prisma.sql`i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`);
    imageWhere.push(
      browsingLevel
        ? Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0`
        : Prisma.sql`i."nsfwLevel" != 0`
    );
  }

  const engines = Object.keys(videoGenerationConfig2);
  const query = Prisma.sql`
     WITH targets AS (
      SELECT
        i.id,
        full_mv.id::int AS "modelVersionId"
      FROM unnest(ARRAY[${Prisma.join(modelVersionIds)}]) AS full_mv(id)
      CROSS JOIN LATERAL
      (
        SELECT
          i.id
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE (p."userId" = m."userId" OR m."userId" = -1)
          AND p."modelVersionId" = full_mv.id
          AND ${Prisma.join(imageWhere, ' AND ')}
          AND (
            (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
            OR NOT i."modelRestricted"
          )
        ORDER BY i."postId", i.index
        LIMIT ${imagesPerVersion}
      ) i
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
      i.minor,
      i.poi,
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
          WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            AND i.meta->>'prompt' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) AS "hasPositivePrompt",
      (
        CASE
          WHEN (i.meta->>'civitaiResources' IS NOT NULL AND NOT (i.meta ? 'Version'))
            OR i.meta->>'engine' IS NOT NULL AND i.meta->>'engine' = ANY(ARRAY[
              ${Prisma.join(engines)}
            ]::text[])
          THEN TRUE
          ELSE FALSE
        END
      ) as "onSite",
      i."meta"->'extra'->'remixOfId' as "remixOfId"
    FROM targets t
    JOIN "Image" i ON i.id = t.id
    JOIN "Post" p ON p.id = i."postId"
    ORDER BY i."postId", i."index"
  `;
  const images = await dbRead.$queryRaw<ImagesForModelVersions[]>(query);

  // const remainingModelVersionIds = modelVersionIds.filter(
  //   (x) => !images.some((i) => i.modelVersionId === x)
  // );

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
    const tagIdsVar = await tagIdsForImagesCache.fetch(imageIds);
    for (const image of images) {
      image.tags = tagIdsVar?.[image.id]?.tags;
    }
  }

  return images;
};

type CachedImagesForModelVersions = {
  modelVersionId: number;
  images: ImagesForModelVersions[];
};
export const imagesForModelVersionsCache = createCachedObject<CachedImagesForModelVersions>({
  key: REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION,
  idKey: 'modelVersionId',
  ttl: CacheTTL.sm,
  // staleWhileRevalidate: false, // We might want to enable this later otherwise there will be a delay after a creator updates their showcase images...
  lookupFn: async (ids) => {
    const images = await getImagesForModelVersion({ modelVersionIds: ids, imagesPerVersion: 20 });

    const records: Record<number, CachedImagesForModelVersions> = {};
    for (const image of images) {
      if (!records[image.modelVersionId])
        records[image.modelVersionId] = { modelVersionId: image.modelVersionId, images: [] };
      records[image.modelVersionId].images.push(image);
    }

    return records;
  },
  appendFn: async (records) => {
    const imageIds = [...records].flatMap((x) => x.images.map((i) => i.id));
    const tagIdsVar = await tagIdsForImagesCache.fetch(imageIds);
    for (const entry of records) {
      for (const image of entry.images) {
        image.tags = tagIdsVar?.[image.id]?.tags ?? [];
      }
    }
  },
});

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

export async function deleteImagesForModelVersionCache(modelVersionId: number | number[]) {
  await imagesForModelVersionsCache.bust(modelVersionId);
}

// TODO cover only is not handled, but is passed in
export const getImagesForPosts = async ({
  postIds,
  // excludedIds,
  coverOnly = true,
  browsingLevel,
  user,
  pending,
  disablePoi,
  disableMinor,
  poiOnly,
  minorOnly,
}: {
  postIds: number | number[];
  // excludedIds?: number[];
  coverOnly?: boolean;
  browsingLevel?: number;
  user?: SessionUser;
  pending?: boolean;
  disablePoi?: boolean;
  disableMinor?: boolean;
  poiOnly?: boolean;
  minorOnly?: boolean;
}) => {
  const userId = user?.id;
  const isModerator = user?.isModerator ?? false;

  if (!Array.isArray(postIds)) postIds = [postIds];
  const imageWhere: Prisma.Sql[] = [Prisma.sql`i."postId" IN (${Prisma.join(postIds)})`];

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
    } else {
      imageWhere.push(Prisma.sql`i."needsReview" IS NULL`);
    }
  } else {
    imageWhere.push(Prisma.sql`i."needsReview" IS NULL AND i."acceptableMinor" = FALSE`);
    imageWhere.push(
      browsingLevel
        ? Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0`
        : Prisma.sql`i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`
    );
  }

  if (disablePoi) {
    imageWhere.push(Prisma.sql`(i."poi" = false OR i."poi" IS NULL OR i."userId" = ${userId})`);
  }

  if (disableMinor) {
    imageWhere.push(Prisma.sql`(i."minor" = false OR i."minor" IS NULL)`);
  }

  if (isModerator) {
    if (poiOnly) {
      imageWhere.push(Prisma.sql`i."poi" = true`);
    }
    if (minorOnly) {
      imageWhere.push(Prisma.sql`i."minor" = true`);
    }
  }

  const engines = Object.keys(videoGenerationConfig2);
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
      postId: number;
      type: MediaType;
      metadata: ImageMetadata | VideoMetadata | null;
      hasMeta: boolean;
      onSite: boolean;
      remixOfId?: number | null;
      hasPositivePrompt?: boolean;
      poi?: boolean;
      minor?: boolean;
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
      i."postId",
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            AND i.meta->>'prompt' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) AS "hasPositivePrompt",
      (
        CASE
          WHEN (i.meta->>'civitaiResources' IS NOT NULL AND NOT (i.meta ? 'Version'))
            OR i.meta->>'engine' IS NOT NULL AND i.meta->>'engine' = ANY(ARRAY[
                ${Prisma.join(engines)}
              ]::text[])
          THEN TRUE
          ELSE FALSE
        END
      ) as "onSite",
      i.metadata->>'remixOfId' as "remixOfId",
      i.minor,
      i.poi
    FROM "Image" i
    WHERE ${Prisma.join(imageWhere, ' AND ')}
      AND (
        (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
        OR NOT i."modelRestricted"
      )
    ORDER BY i.index ASC
  `;
  const imageIds = images.map((i) => i.id);
  const tagIds = await tagIdsForImagesCache.fetch(imageIds);

  return images.map((i) => {
    return {
      ...i,
      tagIds: tagIds[i.id]?.tags,
    };
  });
};

export const removeImageResource = async ({
  imageId,
  modelVersionId,
}: RemoveImageResourceSchema) => {
  try {
    const resource = await dbWrite.imageResourceNew.delete({
      where: { imageId_modelVersionId: { imageId, modelVersionId } },
    });
    // if (!resource) throw throwNotFoundError(`No image resource with id ${id}`);

    purgeImageGenerationDataCache(imageId);
    // purgeCache({ tags: [`image-resources-${imageId}`] });

    return resource;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// export function applyModRulesSql(
//   AND: Prisma.Sql[],
//   { userId, publishedOnly = true }: { userId?: number; publishedOnly?: boolean }
// ) {
//   // Hide images that need review
//   const needsReviewOr = [Prisma.sql`i."needsReview" IS NULL`];
//   // Hide images that aren't published
//   const publishedOr = publishedOnly ? [Prisma.sql`p."publishedAt" < now()`] : [];
//
//   if (userId) {
//     const belongsToUser = Prisma.sql`i."userId" = ${userId}`;
//     needsReviewOr.push(belongsToUser);
//
//     if (publishedOnly) {
//       publishedOr.push(belongsToUser);
//     }
//   }
//
//   AND.push(Prisma.sql`(${Prisma.join(needsReviewOr, ' OR ')})`);
//
//   if (publishedOr.length > 0) {
//     AND.push(Prisma.sql`(${Prisma.join(publishedOr, ' OR ')})`);
//   }
// }

// export type GetIngestionResultsProps = AsyncReturnType<typeof getIngestionResults>;
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
  hasPositivePrompt?: boolean;
  poi?: boolean;
  minor?: boolean;
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

  const AND: Prisma.Sql[] = !isModerator
    ? [
        Prisma.sql`(i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"${
          userId ? Prisma.sql` OR i."userId" = ${userId}` : Prisma.sql``
        })`,
      ]
    : [];

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
        ${AND.length ? Prisma.sql`WHERE ${Prisma.join(AND, ' AND ')}` : Prisma.empty}
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
      i."createdAt",
      i."mimeType",
      i.type,
      i.metadata,
      i.ingestion,
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."index",
      i.poi,
      i.minor,
      (
        CASE
          WHEN i.meta IS NULL OR jsonb_typeof(i.meta) = 'null' OR i."hideMeta" THEN FALSE
          ELSE TRUE
        END
      ) AS "hasMeta",
      (
        CASE
          WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            AND i.meta->>'prompt' IS NOT NULL
          THEN TRUE
          ELSE FALSE
        END
      ) AS "hasPositivePrompt",
      t."entityId"
    FROM targets t
    JOIN "Image" i ON i.id = t.id`;

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined = [];
  if (include && include.includes('tags')) {
    const imageIds = images.map((i) => i.id);
    tagsVar = await getImageTagsForImages(imageIds);
  }

  return images.map((i) => ({
    ...i,
    tags: tagsVar?.filter((x) => x.imageId === i.id),
  }));
};

export async function createImage({
  toolIds,
  techniqueIds,
  skipIngestion,
  ...image
}: ImageSchema & { userId: number; skipIngestion?: boolean }) {
  const result = await dbWrite.image.create({
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: image.meta ? getImageGenerationProcess(image.meta) : null,
      tools: !!toolIds?.length
        ? { createMany: { data: toolIds.map((toolId) => ({ toolId })) } }
        : undefined,
      techniques: !!techniqueIds?.length
        ? { createMany: { data: techniqueIds.map((techniqueId) => ({ techniqueId })) } }
        : undefined,
      ingestion: skipIngestion ? ImageIngestionStatus.PendingManualAssignment : undefined,
    },
    select: { id: true },
  });

  if (!skipIngestion) {
    await upsertImageFlag({ imageId: result.id, prompt: image.meta?.prompt });
    await ingestImage({
      image: {
        id: result.id,
        url: image.url,
        type: image.type,
        height: image.height,
        width: image.width,
        prompt: image?.meta?.prompt,
      },
      userId: image.userId,
    });
  }

  await userImageVideoCountCache.bust(image.userId);

  return result;
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

  const shouldAddImageResources = !!entityType && ['Bounty', 'BountyEntry'].includes(entityType);
  const batches = chunk(imageRecords, 50);
  for (const batch of batches) {
    if (shouldAddImageResources) {
      const tasks = batch.map((image) => () => createImageResources({ imageId: image.id, tx }));
      await limitConcurrency(tasks, 10);
    }

    const tasks = batch.map((image) => () => ingestImage({ image, tx }));
    await limitConcurrency(tasks, 10);
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
  poi?: boolean;
  minor?: boolean;
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
  const imagesRaw = await dbRead.$queryRaw<GetEntityImageRaw[]>`
    WITH entities AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(entities)}::jsonb) AS v(
        "entityId" INTEGER,
        "entityType" VARCHAR
      )
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
      t."entityType",
      i."poi",
      i."minor"
    FROM (
      -- NOTE: Adding "order1/2/3" looks a bit hacky, but it avoids using partitions and makes it far more performant.
      -- It might may look weird, but it has 0 practical effect other than better performance.
       SELECT
         *
        FROM
        (
          -- MODEL
          SELECT DISTINCT ON (e."entityId")
            e."entityId",
            e."entityType",
            i.id as "imageId",
            mv.index "order1",
            p.id "order2",
            i.index "order3"
          FROM entities e
          JOIN "Model" m ON e."entityId" = m.id
          JOIN "ModelVersion" mv ON m.id = mv."modelId"
          JOIN "Post" p ON mv.id = p."modelVersionId" AND p."userId" = m."userId"
          JOIN "Image" i ON p.id = i."postId"
          WHERE e."entityType" = 'Model'
          AND m.status = 'Published'
          AND i."ingestion" = 'Scanned'
          AND i."needsReview" IS NULL
          AND (
            (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
            OR NOT i."modelRestricted"
          )
          ORDER BY e."entityId", mv.index,  p.id, i.index
        ) t

        UNION

        -- MODEL VERSION
        SELECT * FROM (
          SELECT DISTINCT ON (e."entityId")
            e."entityId",
            e."entityType",
            i.id as "imageId",
            mv.index "order1",
            p.id "order2",
            i.index "order3"
          FROM entities e
          JOIN "ModelVersion" mv ON e."entityId" = mv."id"
          JOIN "Post" p ON mv.id = p."modelVersionId"
          JOIN "Image" i ON p.id = i."postId"
          WHERE e."entityType" = 'ModelVersion'
          AND mv.status = 'Published'
          AND i."ingestion" = 'Scanned'
          AND i."needsReview" IS NULL
          AND (
            (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
            OR NOT i."modelRestricted"
          )
          ORDER BY e."entityId", mv.index,  p.id, i.index
        ) t

        UNION
        -- IMAGES
        SELECT
            e."entityId",
            e."entityType",
            e."entityId" AS "imageId",
            0 "order1",
            0 "order2",
            0 "order3"
        FROM entities e
        WHERE e."entityType" = 'Image'

        UNION
        -- ARTICLES
        SELECT * FROM (
          SELECT DISTINCT ON (e."entityId")
              e."entityId",
              e."entityType",
              i.id AS "imageId",
              0 "order1",
	          0 "order2",
	          0 "order3"
          FROM entities e
          JOIN "Article" a ON a.id = e."entityId"
          JOIN "Image" i ON a."coverId" = i.id
          WHERE e."entityType" = 'Article'
          AND a."publishedAt" IS NOT NULL
              AND i."ingestion" = 'Scanned'
              AND i."needsReview" IS NULL
        ) t

        UNION
        -- POSTS
        SELECT * FROM  (
          SELECT DISTINCT ON(e."entityId")
              e."entityId",
              e."entityType",
              i.id AS "imageId",
              i."postId" "order1",
	          i.index "order2",
	          0 "order3"
          FROM entities e
          JOIN "Post" p ON p.id = e."entityId"
          LEFT JOIN "ModelVersion" mv ON p."modelVersionId" = mv.id
          JOIN "Image" i ON i."postId" = p.id
          WHERE e."entityType" = 'Post'
            AND p."publishedAt" IS NOT NULL
            AND i."ingestion" = 'Scanned'
            AND i."needsReview" IS NULL
            AND (
              (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
              OR NOT i."modelRestricted"
            )
          ORDER BY e."entityId", i."postId", i.index
        ) t

        UNION
        -- CONNECTIONS
        SELECT * FROM (
          SELECT
              e."entityId",
              e."entityType",
              i.id AS "imageId",
              0 "order1",
	          0 "order2",
	          0 "order3"
          FROM entities e
          JOIN "ImageConnection" ic ON ic."entityId" = e."entityId" AND ic."entityType" = e."entityType"
          JOIN "Image" i ON i.id = ic."imageId"
        ) t
    ) t
    JOIN "Image" i ON i.id = t."imageId"
    WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL`;

  const images = entities
    .map((e) => {
      const image = imagesRaw.find(
        (i) => i.entityId === e.entityId && i.entityType === e.entityType
      );
      return image ?? null;
    })
    .filter(isDefined);

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined = [];
  if (include && include.includes('tags')) {
    const imageIds = images.map((i) => i.id);
    tagsVar = await getImageTagsForImages(imageIds);
  }

  const cosmetics = await getCosmeticsForEntity({ ids: images.map((i) => i.id), entity: 'Image' });

  return images.map((i) => ({
    ...i,
    tags: tagsVar?.filter((x) => x.imageId === i.id),
    cosmetic: cosmetics[i.id],
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
    const shouldAddImageResources = !!entityType && ['Bounty', 'BountyEntry'].includes(entityType);
    const batches = chunk(imageRecords, 50);
    for (const batch of batches) {
      if (shouldAddImageResources) {
        await Promise.all(batch.map((image) => createImageResources({ imageId: image.id, tx })));
      }

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

const imageReviewQueueJoinMap = {
  report: {
    select: `
      report.id as "reportId",
      report.reason as "reportReason",
      report.status as "reportStatus",
      report.details as "reportDetails",
      array_length("alsoReportedBy", 1) as "reportCount",
      ur.username as "reportUsername",
      ur.id as "reportUserId",
    `,
    join: `
      JOIN "ImageReport" imgr ON i.id = imgr."imageId"
      JOIN "Report" report ON report.id = imgr."reportId"
      JOIN "User" ur ON ur.id = report."userId"
    `,
  },
  appeal: {
    select: `
      appeal.id as "appealId",
      appeal."appealMessage" as "appealMessage",
      appeal."createdAt" as "appealCreatedAt",
      au.id as "appealUserId",
      au.username as "appealUsername",
      mu.id as "moderatorId",
      mu.username as "moderatorUsername",
      ma."createdAt" as "removedAt",
    `,
    join: `
      LEFT JOIN LATERAL (
        SELECT * FROM "Appeal"
        WHERE "entityId" = i.id AND "entityType" = 'Image'
        ORDER BY "createdAt" DESC
        LIMIT 1
      ) appeal ON true
      JOIN "User" au ON au.id = appeal."userId"
      LEFT JOIN "ModActivity" ma ON ma."entityId" = i.id
        AND ma."entityType" = 'image'
        AND ma.activity = 'review'
      LEFT JOIN "User" mu ON mu.id = ma."userId"
    `,
  },
} as const;
type AdditionalQueryKey = keyof typeof imageReviewQueueJoinMap;

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
  createdAt: Date;
  sortAt: Date;
  mimeType: string;
  scannedAt: Date;
  ingestion: ImageIngestionStatus;
  blockedFor: BlockedReason | null;
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
  appealId?: number;
  appealMessage?: string;
  appealCreatedAt?: Date;
  appealUserId?: number;
  appealUsername?: string;
  moderatorId?: number;
  moderatorUsername?: string;
  removedAt?: Date;
  minor: boolean;
  acceptableMinor: boolean;
  poi?: boolean;
};
type ReviewTag = { id: number; name: string; nsfwLevel: number; imageId: number };
export const getImageModerationReviewQueue = async ({
  limit,
  cursor,
  needsReview,
  tagReview,
  reportReview,
  browsingLevel,
  tagIds,
  excludedTagIds,
}: ImageReviewQueueInput) => {
  const AND: Prisma.Sql[] = [];
  AND.push(Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0`);

  if (needsReview) {
    AND.push(Prisma.sql`i."needsReview" = ${needsReview}`);
  }

  if (needsReview && needsReview !== 'appeal') {
    AND.push(Prisma.sql`(i."ingestion" = 'Scanned')`);
  }

  if (tagIds?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImageDetails" toi
      WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(tagIds)})
    )`);
  }

  if (excludedTagIds?.length) {
    AND.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "ImageTagForReview" toi
      WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(excludedTagIds)})
    )`);
  }
  // Order by oldest first. This is to ensure that images that have been in the queue the longest
  // are reviewed first.
  let orderBy = `i."id" DESC`;

  let cursorProp = 'i."id"';
  let cursorDirection = 'DESC';
  let tagReviewCTE: Prisma.Sql | undefined;
  let tagReviewJoin: Prisma.Sql | undefined;

  if (tagReview) {
    AND.push(Prisma.sql`
      i."nsfwLevel" < ${NsfwLevel.Blocked}
    `);

    // Optimize: Use CTE to filter tags first with explicit materialization
    // This forces PostgreSQL to scan the partial index first before joining to images
    tagReviewCTE = Prisma.sql`
      WITH reviewable_images AS MATERIALIZED (
        SELECT DISTINCT "imageId"
        FROM "TagsOnImageNew"
        WHERE (((attributes >> 9)::integer & 1) = 1)      -- needsReview = true
          AND (((attributes >> 10)::integer & 1) <> 1)    -- disabled = false
          ${cursor ? Prisma.sql`AND "imageId" < ${cursor}` : Prisma.sql``}
        ORDER BY "imageId" DESC
      )
    `;

    // Join to the materialized CTE
    tagReviewJoin = Prisma.sql`
      INNER JOIN reviewable_images ri ON ri."imageId" = i.id
    `;
  } else {
    if (reportReview) {
      // Add this to the WHERE:
      AND.push(Prisma.sql`report."status" = 'Pending'`);
      // Also, update sorter to most recent:
      orderBy = `report."createdAt" ASC`;
      cursorProp = 'report.id';
      cursorDirection = 'ASC';
    }
  }

  if (cursor) {
    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    AND.push(Prisma.sql`${Prisma.raw(cursorProp)} ${Prisma.raw(cursorOperator)} ${cursor}`);
  }

  // TODO: find a better way to handle different select/join for each type of review
  const queryKey = reportReview ? 'report' : (needsReview as AdditionalQueryKey);
  const additionalQuery = queryKey ? imageReviewQueueJoinMap[queryKey] : undefined;

  const query = Prisma.sql`
    -- Image moderation queue
    ${tagReviewCTE ? tagReviewCTE : Prisma.empty}
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
      i."createdAt",
      GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
      i."mimeType",
      i.type,
      i.metadata,
      i.ingestion,
      i."blockedFor",
      i."scannedAt",
      i."needsReview",
      i."userId",
      i."postId",
      p."title" "postTitle",
      i."index",
      i.minor,
      i.poi,
      i."acceptableMinor",
      p."publishedAt",
      p."modelVersionId",
      u.username,
      u.image "userImage",
      u."deletedAt",
      ic."entityType",
      ic."entityId",
      ${Prisma.raw(additionalQuery ? additionalQuery.select : '')}
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
      FROM "Image" i
      JOIN "User" u ON u.id = i."userId"
      LEFT JOIN "Post" p ON p.id = i."postId"
      LEFT JOIN "ImageConnection" ic on ic."imageId" = i.id
      ${Prisma.raw(additionalQuery ? additionalQuery.join : '')}
      ${tagReviewJoin ? tagReviewJoin : Prisma.empty}
      WHERE ${Prisma.join(AND, ' AND ')}
      ORDER BY ${Prisma.raw(orderBy)}
      LIMIT ${limit + 1}
  `;

  // if (isDev) {
  //   console.log(getExplainSql(query));
  // }

  const rawImages = await dbRead.$queryRaw<GetImageModerationReviewQueueRaw[]>`${query}`;

  let nextCursor: bigint | undefined;

  if (rawImages.length > limit) {
    const nextItem = rawImages.pop();
    nextCursor = nextItem?.cursorId;
  }

  const imageIds = rawImages.map((i) => i.id);
  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined;

  if (tagReview) {
    tagsVar = await getImageTagsForImages(imageIds);
  }

  const reviewTags =
    needsReview && imageIds.length > 0
      ? await dbWrite.$queryRaw<ReviewTag[]>`
          SELECT
            t.id,
            t.name,
            t."nsfwLevel",
            itr."imageId"
          FROM "ImageTagForReview" itr
          JOIN "Tag" t ON itr."tagId" = t.id
          WHERE itr."imageId" IN (${Prisma.join(imageIds)})
        `
      : [];

  let tosDetails: Map<number, { tosReason: string }> | undefined;
  if (clickhouse && needsReview === 'appeal' && imageIds.length > 0) {
    const tosImages = await clickhouse.$query<{ imageId: number; tosReason: string }>`
      SELECT imageId, tosReason
      FROM images
      WHERE imageId IN (${imageIds})
        AND type = 'DeleteTOS'
        AND tosReason IS NOT NULL
    `;

    for (const image of tosImages) {
      if (!tosDetails) tosDetails = new Map();
      tosDetails.set(image.imageId, { tosReason: image.tosReason });
    }
  }

  const images: Array<
    Omit<ImageV2Model, 'stats' | 'metadata'> & {
      meta: ImageMetaProps | null;
      tags?: VotableTagModel[] | undefined;
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
      appeal?:
        | {
            id: number;
            reason: string;
            createdAt: Date;
            user: { id: number; username?: string | null };
            moderator?: { id: number; username?: string | null };
          }
        | undefined;
      publishedAt?: Date | null;
      modelVersionId?: number | null;
      entityType?: string | null;
      entityId?: number | null;
      metadata?: ImageMetadata | VideoMetadata | null;
      removedAt?: Date | null;
      tosReason?: string | null;
      minor: boolean;
      acceptableMinor: boolean;
      reviewTags: ReviewTag[];
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
      appealId,
      appealMessage,
      appealCreatedAt,
      appealUserId,
      appealUsername,
      removedAt,
      moderatorId,
      moderatorUsername,
      ...i
    }) => ({
      ...i,
      metadata: i.metadata as ImageMetadata | VideoMetadata | null,
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
      reviewTags: reviewTags.filter((x) => x.imageId === i.id),
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
      appeal: appealId
        ? {
            id: appealId,
            reason: appealMessage as string,
            createdAt: appealCreatedAt as Date,
            user: { id: appealUserId as number, username: appealUsername },
            moderator: { id: moderatorId as number, username: moderatorUsername },
          }
        : undefined,
      removedAt,
      tosReason: tosDetails?.get(i.id)?.tosReason,
    })
  );

  return { nextCursor, items: images };
};

export async function getImageModerationCounts() {
  const result = await dbWrite.$queryRaw<{ needsReview: string; count: number }[]>`
    SELECT
      "needsReview",
      COUNT(*)
    FROM (
      SELECT "needsReview" FROM "Image"
      WHERE "needsReview" IS NOT NULL AND (("needsReview" != 'appeal' AND "ingestion" = 'Scanned') OR "needsReview" = 'appeal')

      UNION ALL

      SELECT 'reported' AS "needsReview" FROM (
        SELECT ir."imageId" FROM "Report" r
        JOIN "ImageReport" ir ON ir."reportId" = r.id
        WHERE r.status = 'Pending'
        GROUP BY ir."imageId"
      )
    )
    GROUP BY "needsReview";
  `;

  return result.reduce<Record<string, number>>(
    (acc, { needsReview, count }) => ({ ...acc, [needsReview]: Number(count) }),
    {}
  );
}

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
    JOIN "TagsOnImageNew" toi ON toi."imageId" = i.id
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

// async function removeNameReference(imageIds: number[]) {
//   const tasks = chunk(imageIds, 500).map((imageIds) => async () => {
//     // Get images to de-reference
//     const [targets, prompts] = await Promise.all([
//       dbRead.$queryRaw<NameReference[]>`
//         SELECT
//           toi."imageId",
//           t.id as "tagId",
//           t.name
//         FROM "TagsOnImageNew" toi
//         JOIN "TagsOnTags" tot ON tot."toTagId" = toi."tagId"
//         JOIN "Tag" t ON t.id = tot."toTagId"
//         JOIN "Tag" f ON f.id = tot."fromTagId" AND f.name = 'real person'
//         WHERE toi."imageId" IN (${Prisma.join(imageIds)});
//       `,
//       // Update prompts
//       dbRead.$queryRaw<{ imageId: number; prompt: string }[]>`
//         SELECT
//           i.id as "imageId",
//           meta->>'prompt' as prompt
//         FROM "Image" i
//         WHERE id IN (${Prisma.join(imageIds)});
//       `,
//     ]);

//     // Update prompts
//     for (const x of prompts) {
//       const { name } = targets.find((target) => target.imageId === x.imageId) ?? {};
//       if (!name) continue;

//       x.prompt = promptWordReplace(x.prompt, name, 'person');
//     }

//     const promptsJson = JSON.stringify(prompts);
//     await dbWrite.$executeRaw`
//       WITH updates AS (
//         SELECT
//           CAST(t->>'imageId' as int) as id,
//           t->>'prompt' as prompt
//         FROM json_array_elements(${promptsJson}::json) t
//       )
//       UPDATE "Image" i
//         SET meta = jsonb_set(meta, '{prompt}', to_jsonb(t.prompt)),
//           "needsReview" = null,
//           poi = false,
//           ingestion = 'Scanned'::"ImageIngestionStatus",
//           "blockedFor" = null
//       FROM updates t
//       WHERE t.id = i.id;
//     `;

//     await upsertTagsOnImageNew(
//       targets.map(({ tagId, imageId }) => ({ tagId, imageId, disabled: true, needsReview: false }))
//     );
//   });

//   await limitConcurrency(tasks, 3);
// }

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
  userId,
  status,
  isModerator,
  activity,
  reason,
}: UpdateImageNsfwLevelOutput & {
  userId: number;
  isModerator?: boolean;
  activity?: ImageModActivity['activity'];
}) {
  if (!nsfwLevel) throw throwBadRequestError();
  if (isModerator) {
    const image = await dbRead.image.findUnique({ where: { id }, select: { metadata: true } });
    if (!image) throw throwNotFoundError('Image not found');

    const metadata = (image.metadata as ImageMetadata) ?? undefined;
    if (activity === 'setNsfwLevelKono' && !reason) reason = 'Knights Vote';
    const updatedMetadata = { ...metadata, nsfwLevelReason: reason ?? null };

    await dbWrite.image.update({
      where: { id },
      data: { nsfwLevel, nsfwLevelLocked: true, metadata: updatedMetadata },
    });
    // Current meilisearch image index gets locked specially when doing a single image update due to the cheer size of this index.
    // Commenting this out should solve the problem.
    // await imagesSearchIndex.updateSync([{ id, action: SearchIndexUpdateQueueAction.Update }]);
    if (status) {
      await dbWrite.imageRatingRequest.updateMany({
        where: { imageId: id, status: 'Pending' },
        data: { status },
      });
    }
    await trackModActivity(userId, {
      entityType: 'image',
      entityId: id,
      activity: activity ?? 'setNsfwLevel',
    });
  } else {
    // Track potential content leaking
    // If the image is currently PG and the new level is R or higher, and the image isn't from the original user, increment the counter
    const current = await dbWrite.image.findFirst({
      where: { id },
      select: { nsfwLevel: true, userId: true, nsfwLevelLocked: true },
    });
    if (!current) return;
    if (
      current?.nsfwLevel === NsfwLevel.PG &&
      nsfwLevel >= NsfwLevel.R &&
      current?.userId !== userId
    ) {
      leakingContentCounter.inc();
    }

    if (!current.nsfwLevelLocked) {
      await dbWrite.imageRatingRequest.upsert({
        where: { imageId_userId: { imageId: id, userId: userId } },
        create: {
          nsfwLevel,
          imageId: id,
          userId: userId,
          weight: current.userId === userId ? 3 : 1,
        },
        update: { nsfwLevel },
      });

      if (current.userId === userId) {
        await addImageToQueue({
          imageIds: id,
          rankType: NewOrderRankType.Knight,
          priority: 1,
        });
      }
    }
  }

  return nsfwLevel;
}

type ImageRatingRequestResponse = {
  id: number;
  votes: Record<number, number>;
  url: string;
  nsfwLevel: number;
  nsfwLevelLocked: boolean;
  width: number | null;
  height: number | null;
  type: MediaType;
  total: number;
  createdAt: Date;
};

export async function getImageRatingRequests({
  cursor,
  limit,
  user,
}: ImageRatingReviewOutput & { user: SessionUser }) {
  // const results = await dbRead.$queryRaw<ImageRatingRequestResponse[]>`
  //   WITH CTE_Requests AS (
  //     SELECT
  //       DISTINCT ON (irr."imageId") irr."imageId" as id,
  //       MIN(irr."createdAt") as "createdAt",
  //       COUNT(CASE WHEN i."nsfwLevel" != irr."nsfwLevel" THEN i.id END)::INT "total",
  //       SUM(CASE WHEN irr."userId" = i."userId" THEN irr."nsfwLevel" ELSE 0 END)::INT "ownerVote",
  //       i.url,
  //       i."nsfwLevel",
  //       i."nsfwLevelLocked",
  //       i.type,
  //       i.height,
  //       i.width,
  //       jsonb_build_object(
  //         ${NsfwLevel.PG}, count(irr."nsfwLevel")
  //           FILTER (where irr."nsfwLevel" = ${NsfwLevel.PG}),
  //         ${NsfwLevel.PG13}, count(irr."nsfwLevel")
  //           FILTER (where irr."nsfwLevel" = ${NsfwLevel.PG13}),
  //         ${NsfwLevel.R}, count(irr."nsfwLevel")
  //           FILTER (where irr."nsfwLevel" = ${NsfwLevel.R}),
  //         ${NsfwLevel.X}, count(irr."nsfwLevel")
  //           FILTER (where irr."nsfwLevel" = ${NsfwLevel.X}),
  //         ${NsfwLevel.XXX}, count(irr."nsfwLevel")
  //           FILTER (where irr."nsfwLevel" = ${NsfwLevel.XXX})
  //       ) "votes"
  //       FROM "ImageRatingRequest" irr
  //       JOIN "Image" i on i.id = irr."imageId"
  //       WHERE irr.status = ${ReportStatus.Pending}::"ReportStatus"
  //         AND i."nsfwLevel" != ${NsfwLevel.Blocked}
  //       GROUP BY irr."imageId", i.id
  //   )
  //   SELECT
  //     r.*
  //   FROM CTE_Requests r
  //   WHERE (r.total >= 3 OR (r."ownerVote" != 0 AND r."ownerVote" != r."nsfwLevel"))
  //   ${!!cursor ? Prisma.sql` AND r."createdAt" >= ${new Date(cursor)}` : Prisma.sql``}
  //   ORDER BY r."createdAt"
  //   LIMIT ${limit + 1}
  // `;

  // const results = await dbRead.$queryRaw<ImageRatingRequestResponse[]>`
  // WITH image_rating_requests AS (
  //     SELECT
  //       irr.*,
  //       i."userId"  "imageUserId",
  //       i."nsfwLevel"  "imageNsfwLevel"
  //     FROM "ImageRatingRequest" irr
  //     JOIN "Image" i ON i.id = irr."imageId"
  //     WHERE irr.status = ${ReportStatus.Pending}::"ReportStatus"
  //     AND irr."nsfwLevel" != ${NsfwLevel.Blocked}
  //     ORDER BY irr."createdAt"
  //   ),
  //   requests AS (
  //     SELECT
  //       "imageId" id,
  //       MIN("createdAt") as "createdAt",
  //       COUNT(CASE WHEN "nsfwLevel" != "imageNsfwLevel" THEN "imageId" END)::INT "total",
  //       COALESCE(bit_or(CASE WHEN "userId" = "imageUserId" THEN "nsfwLevel" ELSE 0 END))::INT "ownerVote",
  //       jsonb_build_object(
  //           ${NsfwLevel.PG}, count("nsfwLevel")
  //             FILTER (where "nsfwLevel" = ${NsfwLevel.PG}),
  //           ${NsfwLevel.PG13}, count("nsfwLevel")
  //             FILTER (where "nsfwLevel" = ${NsfwLevel.PG13}),
  //           ${NsfwLevel.R}, count("nsfwLevel")
  //             FILTER (where "nsfwLevel" = ${NsfwLevel.R}),
  //           ${NsfwLevel.X}, count("nsfwLevel")
  //             FILTER (where "nsfwLevel" = ${NsfwLevel.X}),
  //           ${NsfwLevel.XXX}, count("nsfwLevel")
  //             FILTER (where "nsfwLevel" = ${NsfwLevel.XXX})
  //         ) "votes"
  //     FROM image_rating_requests
  //     GROUP BY "imageId"
  //   )
  //   SELECT
  //     i.url,
  //     i."nsfwLevel",
  //     i."nsfwLevelLocked",
  //     i."userId",
  //     i.type,
  //     i.width,
  //     i.height,
  //     r.*
  //   FROM requests r
  //   JOIN "Image" i ON i.id = r."id"
  //   WHERE (r.total >= 3 OR (r."ownerVote" != 0 AND r."ownerVote" != i."nsfwLevel"))
  //   AND i."blockedFor" IS NULL
  //   ${!!cursor ? Prisma.sql` AND r."createdAt" >= ${new Date(cursor)}` : Prisma.sql``}
  //   ORDER BY r."createdAt"
  //   LIMIT ${limit + 1}
  // `;

  const query = Prisma.sql`
      WITH image_rating_requests AS (
        SELECT
          "imageId",
          COALESCE(SUM(weight), 0) total,
          MIN("createdAt") "createdAt",
          jsonb_build_object(
            1, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 1),0),
            2, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 2),0),
            4, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 4),0),
            8, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 8),0),
            16, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 16),0)
          ) "votes"
        FROM "ImageRatingRequest"
        WHERE status = 'Pending'
        GROUP BY "imageId"
      )
      SELECT
        i.id,
        irr.votes,
        irr.total::int,
        i.url,
        i."nsfwLevel",
        i."nsfwLevelLocked",
        i.width,
        i.height,
        i.type,
        i."createdAt"
      FROM image_rating_requests irr
      JOIN "Image" i ON i.id = irr."imageId"
      WHERE irr.total >= 3
        AND i."blockedFor" IS NULL
        AND i."nsfwLevelLocked" = FALSE
        AND i.ingestion != 'PendingManualAssignment'::"ImageIngestionStatus"
        AND i."nsfwLevel" < ${NsfwLevel.Blocked}
        ${!!cursor ? Prisma.sql` AND i."id" >= ${cursor}` : Prisma.empty}
      ORDER BY i."id" ASC
      LIMIT ${limit + 1}
  `;

  const results = await dbRead.$queryRaw<ImageRatingRequestResponse[]>`${query}`;

  let nextCursor: number | undefined;
  if (limit && results.length > limit) {
    const nextItem = results.pop();
    nextCursor = nextItem?.id || undefined;
  }

  const imageIds = results.map((x) => x.id);
  const tags = await getVotableTags2({
    ids: imageIds,
    user,
    type: 'image',
    nsfwLevel: Flags.arrayToInstance([
      NsfwLevel.PG13,
      NsfwLevel.R,
      NsfwLevel.X,
      NsfwLevel.XXX,
      NsfwLevel.Blocked,
    ]),
  });

  return {
    nextCursor,
    items: results.map((item) => ({ ...item, tags: tags.filter((x) => x.imageId === item.id) })),
  };
}

type DownleveledImageRecord = {
  imageId: number;
  originalLevel: number;
  createdAt: string;
};

type DownleveledImageResponse = {
  id: number;
  url: string;
  nsfwLevel: number;
  type: MediaType;
  width: number | null;
  height: number | null;
  originalLevel: number;
};

export async function getDownleveledImages({
  cursor,
  limit,
  originalLevel,
  user,
}: DownleveledReviewOutput & { user: SessionUser }) {
  if (!clickhouse) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'ClickHouse is not available',
    });
  }

  // Build WHERE conditions for ClickHouse query
  const whereConditions: string[] = [];
  if (cursor) {
    whereConditions.push(`createdAt <= '${cursor}'`);
  }
  if (originalLevel !== undefined) {
    whereConditions.push(`originalLevel = ${originalLevel}`);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Query ClickHouse for downleveled images
  const query = `
    SELECT imageId, originalLevel, createdAt
    FROM knights_new_order_downleveled
    ${whereClause}
    ORDER BY createdAt DESC
    LIMIT ${limit + 1}
  `;

  const clickhouseResults = await clickhouse.$query<DownleveledImageRecord>(query);

  let nextCursor: string | undefined;
  if (limit && clickhouseResults.length > limit) {
    const nextItem = clickhouseResults.pop();
    nextCursor = nextItem?.createdAt;
  }

  if (clickhouseResults.length === 0) {
    return {
      nextCursor,
      items: [],
    };
  }

  // Get image data from PostgreSQL
  const imageIds = clickhouseResults.map((x) => x.imageId);
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: {
      id: true,
      url: true,
      nsfwLevel: true,
      type: true,
      width: true,
      height: true,
    },
  });

  // Create a map for quick lookup
  const imageMap = new Map(images.map((img) => [img.id, img]));

  // Combine data
  const items: DownleveledImageResponse[] = clickhouseResults
    .map((chRecord) => {
      const image = imageMap.get(chRecord.imageId);
      if (!image) return null;
      return {
        id: image.id,
        url: image.url,
        nsfwLevel: image.nsfwLevel,
        type: image.type,
        width: image.width,
        height: image.height,
        originalLevel: chRecord.originalLevel,
      };
    })
    .filter((item): item is DownleveledImageResponse => item !== null);

  return {
    nextCursor,
    items,
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
  // Update these images if blocked:
  const updated = await dbWrite.image.updateManyAndReturn({
    where: { id: { in: data.map((x) => x.imageId) }, blockedFor: BlockedReason.AiNotVerified },
    data: {
      blockedFor: null,
      // Ensures we do another run:
      ingestion: 'Pending',
    },
    select: {
      id: true,
      url: true,
    },
  });

  if (updated.length > 0) {
    await ingestImageBulk({
      images: updated,
      lowPriority: true,
    });
  }

  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }

  await queueImageSearchIndexUpdate({
    ids: data.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
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

  await queueImageSearchIndexUpdate({
    ids: data.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
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

  await queueImageSearchIndexUpdate({
    ids: data.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
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

  await queueImageSearchIndexUpdate({
    ids: data.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
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
  purgeCache({ tags: [`image-generation-data-${id}`] }).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'purgeImageGenerationDataCache',
      message: error.message,
      error,
    })
  );
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
        orderBy: { tool: { priority: 'asc' } },
        select: {
          notes: true,
          tool: {
            select: {
              id: true,
              name: true,
              icon: true,
              domain: true,
              priority: true,
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

  const cachedResources = await imageResourcesCache.fetch([id]);
  const resources = (cachedResources[id]?.resources ?? []).map((r) => ({
    imageId: r.imageId,
    modelVersionId: r.modelVersionId,
    strength: r.strength,
    modelId: r.modelId,
    modelName: r.modelName,
    modelType: r.modelType as ModelType,
    versionId: r.modelVersionId, // versionId is the same as modelVersionId
    versionName: r.versionName,
    baseModel: r.baseModel,
  }));

  const parsedMeta = imageMetaOutput.safeParse(image.meta);
  const data = parsedMeta.success ? parsedMeta.data : {};
  const { 'Clip skip': legacyClipSkip, clipSkip = legacyClipSkip, external, ...rest } = data;
  const meta =
    parsedMeta.success && !image.hideMeta ? removeEmpty({ ...rest, clipSkip }) : undefined;

  let onSite = false;
  let process: string | undefined | null = undefined;
  let hasControlNet = false;
  if (meta) {
    if ('civitaiResources' in meta && !('Version' in meta)) onSite = true;
    else if ('engine' in meta && meta.engine === 'openai') onSite = true;
    else if ('engine' in meta) {
      process = meta.process ?? meta.type;
      if (process) {
        onSite = true;
      }
    }

    if (meta.comfy) {
      hasControlNet = !!meta.controlNets?.length;
    } else {
      hasControlNet = Object.keys(meta).some((x) => x.toLowerCase().startsWith('controlnet'));
    }

    if (!process) {
      if (meta.comfy) process = 'comfy';
      else if (image.generationProcess === 'txt2imgHiRes') process = 'txt2img + Hi-Res';
      else process = image.generationProcess;

      if (process && hasControlNet) process += ' + ControlNet';
    }
  }

  return {
    type: image.type,
    onSite,
    process,
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
    remixOfId: meta?.extra?.remixOfId,
  };
}

// LRU cache for contest collection items lookup - caches by imageId
// This avoids repeated database queries for the same image's contest participation
type ContestCollectionItem = {
  id: number;
  imageId: number;
  status: string;
  tag: { id: number; name: string } | null;
  collection: { id: number; name: string; metadata: Prisma.JsonValue; mode: 'Contest' };
  scores: { userId: number; score: number }[];
};
const contestCollectionItemsCache = createLruCache({
  name: 'contest-collection-items',
  max: 10_000,
  ttl: 5 * 60 * 1000, // 5 minutes
  keyFn: (imageId: number) => `image:${imageId}`,
  fetchFn: async (imageId: number) => {
    return dbRead.$queryRaw<ContestCollectionItem[]>`
      SELECT
        ci.id,
        ci."imageId",
        ci.status,
        CASE WHEN t.id IS NOT NULL
          THEN jsonb_build_object('id', t.id, 'name', t.name)
          ELSE NULL
        END as tag,
        jsonb_build_object('id', c.id, 'name', c.name, 'metadata', c.metadata, 'mode', c.mode) as collection,
        COALESCE(
          (SELECT jsonb_agg(jsonb_build_object('userId', cis."userId", 'score', cis.score))
           FROM "CollectionItemScore" cis
           WHERE cis."collectionItemId" = ci.id),
          '[]'::jsonb
        ) as scores
      FROM "CollectionItem" ci
      JOIN "Collection" c ON c.id = ci."collectionId"
      LEFT JOIN "Tag" t ON t.id = ci."tagId"
      WHERE ci."imageId" = ${imageId}
        AND c.mode = 'Contest'
    `;
  },
});

export const getImageContestCollectionDetails = async ({
  id,
  userId,
}: { userId?: number } & GetByIdInput) => {
  const items = await contestCollectionItemsCache.fetch(id);

  // Fetch all permissions in one query instead of N queries
  const collectionIds = items.map((i) => i.collection.id);
  const allPermissions = await getUserCollectionPermissionsByIds({
    ids: collectionIds,
    userId,
  });

  return items.map((i) => ({
    ...i,
    permissions: allPermissions.find((p) => p.collectionId === i.collection.id),
    collection: {
      ...i.collection,
      metadata: (i.collection.metadata ?? {}) as CollectionMetadataSchema,
    },
  }));
};

// this method should hopefully not be a lasting addition
export type ModerationImageModel = AsyncReturnType<typeof getImagesByUserIdForModeration>[number];

export async function getImagesByUserIdForModeration(userId: number) {
  const { tags, meta, ...select } = imageSelect;
  return await dbRead.image.findMany({
    where: { userId },
    select,
  });
}

export function addBlockedImage({
  hash,
  reason,
}: {
  hash: bigint | number;
  reason: BlockImageReason;
}) {
  return clickhouse?.insert({
    table: 'blocked_images',
    values: [{ hash: Number(hash), reason }],
    format: 'JSONEachRow',
  });
}

export function bulkAddBlockedImages({
  data,
}: {
  data: { hash: bigint | number; reason: BlockImageReason }[];
}) {
  if (data.length === 0) return;

  const values = data.map(({ hash, reason }) => ({
    hash: Number(hash),
    reason: reason.toString(),
  }));

  return clickhouse?.insert({
    table: 'blocked_images',
    values,
    format: 'JSONEachRow',
  });
}

export async function bulkRemoveBlockedImages(hashes: Array<bigint | number>) {
  if (hashes.length === 0 || !clickhouse) return;
  const blocked = await clickhouse.$query<{ hash: bigint; reason: string }>`
    SELECT hash, reason
    FROM "blocked_images"
    WHERE hash IN (${hashes.join(',')}) AND disabled = false
  `;

  const values = blocked.map(({ hash, reason }) => ({
    hash: Number(hash),
    reason,
    disabled: true,
  }));

  return await clickhouse.insert({
    table: 'blocked_images',
    values,
    format: 'JSONEachRow',
  });
}

// export async function bulkRemoveBlockedImages({
//   ids,
//   hashes,
// }: {
//   hashes?: bigint[] | number[];
//   ids?: number[];
// }) {
//   if (ids) {
//     const images = await dbWrite.image.findMany({
//       where: { id: { in: ids } },
//       select: { pHash: true },
//     });

//     hashes = images.map((i) => i.pHash as bigint).filter(isDefined);
//   }

//   if (!hashes?.length) return;

//   return dbWrite.blockedImage.deleteMany({ where: { hash: { in: hashes } } });
// }

export async function getImagesPendingIngestion() {
  const date = new Date();
  date.setDate(date.getDate() - 5);
  return await dbRead.image.findMany({
    where: { ingestion: 'Pending', createdAt: { gt: date } },
    select: {
      id: true,
      name: true,
      url: true,
      createdAt: true,
      metadata: true,
    },
    orderBy: { id: 'desc' },
  });
}

export async function queueImageSearchIndexUpdate({
  ids,
  action,
}: {
  ids: number[];
  action: SearchIndexUpdateQueueAction;
}) {
  await imagesSearchIndex.queueUpdate(ids.map((id) => ({ id, action })));
  await imagesMetricsSearchIndex.queueUpdate(ids.map((id) => ({ id, action })));

  if (action === SearchIndexUpdateQueueAction.Delete) {
    // Bust the thumbnail cache for deleted images
    await thumbnailCache.bust(ids);
    // Remove the image from the knights of new order pool counters
    await Promise.all([
      ...poolCounters.Knight.a.map((queue) => queue.reset({ id: ids })),
      ...poolCounters.Knight.b.map((queue) => queue.reset({ id: ids })),
      ...poolCounters.Templar.a.map((queue) => queue.reset({ id: ids })),
      ...poolCounters.Templar.b.map((queue) => queue.reset({ id: ids })),
    ]);
  }
}

export async function getPostDetailByImageId({ imageId }: { imageId: number }) {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { postId: true },
  });
  if (!image || !image.postId) return null;

  const post = await dbRead.post.findUnique({
    where: { id: image.postId },
    select: { title: true, detail: true },
  });
  if (!post) return null;

  return post;
}

export async function setVideoThumbnail({
  imageId,
  frame,
  customThumbnail,
  userId,
  isModerator,
  postId,
}: SetVideoThumbnailInput & { userId: number; isModerator?: boolean }) {
  const db = await getDbWithoutLag('postImages', postId);
  const image = await db.image.findUnique({
    where: { id: imageId, userId: !isModerator ? userId : undefined },
    select: { id: true, type: true, metadata: true, userId: true },
  });
  if (!image)
    throw throwAuthorizationError("You don't have permission to set the thumbnail for this video.");
  if (image.type !== MediaType.video) throw throwBadRequestError('This is not a video.');

  let thumbnailId = customThumbnail?.id;
  if (customThumbnail) {
    const thumbnail = await createImage({
      ...customThumbnail,
      userId: image.userId,
      metadata: { parentId: image.id },
    });
    thumbnailId = thumbnail.id;
  }

  const videoMetadata = image.metadata as VideoMetadata;
  const updated = await dbWrite.image.update({
    where: { id: imageId },
    data: { metadata: { ...videoMetadata, thumbnailFrame: frame, thumbnailId } },
  });

  // Clear up the thumbnail cache
  await Promise.all([
    preventReplicationLag('postImages', postId),
    thumbnailCache.bust(imageId),
    queueImageSearchIndexUpdate({
      ids: [imageId],
      action: SearchIndexUpdateQueueAction.Update,
    }),
  ]);

  return updated;
}

export async function updateImageAcceptableMinor({
  id,
  acceptableMinor,
}: UpdateImageAcceptableMinorInput) {
  const image = await dbWrite.image.update({
    where: { id },
    data: { acceptableMinor },
  });

  // Remove it from search index if minor is true
  await queueImageSearchIndexUpdate({
    ids: [id],
    action: acceptableMinor
      ? SearchIndexUpdateQueueAction.Delete
      : SearchIndexUpdateQueueAction.Update,
  });
  if (acceptableMinor) {
    await invalidateManyImageExistence([id]);
  }

  return image;
}

export async function getImageResourcesFromImageId({
  imageId,
  tx,
}: {
  imageId: number;
  tx?: Prisma.TransactionClient;
}) {
  const dbClient = tx ?? dbWrite;
  const computed = await dbClient.$queryRaw<
    {
      id: number;
      modelversionid: number | null;
      hash: string | null;
      strength: number | null;
      detected: boolean;
    }[]
  >`SELECT * FROM get_image_resources(${imageId}::int)`;
  return computed;
}

export async function createImageResources({
  imageId,
  tx,
}: {
  imageId: number;
  tx?: Prisma.TransactionClient;
}) {
  const dbClient = tx ?? dbWrite;
  // Read the resources based on complex metadata and hash matches
  const resources = await getImageResourcesFromImageId({ imageId, tx });
  if (!resources.length) return null;

  const withModelVersionId = resources
    .map((x) => {
      if (!x.modelversionid) return null;
      return x;
    })
    .filter(isDefined);
  const resourcesWithModelVersions = uniqBy(withModelVersionId, 'modelversionid');

  if (resourcesWithModelVersions.length) {
    const values = Prisma.join(
      resourcesWithModelVersions.map(
        (r) => Prisma.sql`(${r.id}, ${r.modelversionid}, ${r.strength}, ${r.detected})`
      )
    );

    await dbClient.$queryRaw`
      INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId", strength, detected)
      VALUES ${values}
      ON CONFLICT ("imageId", "modelVersionId") DO UPDATE
      SET
        detected = excluded.detected,
        strength = excluded.strength;
    `;
  }

  return resources;
}

export const getMyImages = async ({
  mediaTypes,
  userId,
  limit,
  cursor = 0,
}: GetMyImagesInput & { userId: number }) => {
  const allowedMediaTypes = mediaTypes.filter((x) => x !== MediaType.audio);

  try {
    const media = await dbRead.image.findMany({
      select: { id: true, url: true, meta: true, createdAt: true, type: true },
      where: {
        userId,
        type: {
          in: allowedMediaTypes.length ? allowedMediaTypes : [MediaType.image, MediaType.video],
        },
        postId: { not: null },
        ingestion: ImageIngestionStatus.Scanned,
      },
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { id: 'desc' },
    });

    let nextCursor: number | undefined;
    if (media.length > limit) {
      const nextItem = media.pop();
      nextCursor = nextItem?.id;
    }

    return {
      items: media,
      nextCursor,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const uploadImageFromUrl = async ({ imageUrl }: { imageUrl: string }) => {
  const blob = await fetchBlob(imageUrl);

  if (!blob) {
    throw new Error('Failed to fetch image');
  }

  const imageKey = randomUUID();

  const upload = await serverUploadImage({
    file: blob,
    key: imageKey,
    bucket: env.S3_IMAGE_UPLOAD_BUCKET,
  });

  const data = await upload.done();
  const meta = await getMetadata(imageUrl);
  // Attempt to guess if this is a video or image based off of the sample image url.
  // This is no accurate science for all scenarios, but should give out a decent result at least.
  const isVideo = imageUrl.includes('.mp4') || imageUrl.includes('.mov');

  const response = {
    type: (isVideo ? 'video' : 'image') as MediaType,
    meta: meta,
    metadata: {
      size: blob.size,
      // We need a better way to determine the size of the content here. However, due to the fact that we can't
      // present these images in the server size, we have no exact measurements. We can only assume the size.
      // The front-end has an easier time determining the size of the content because they can render it.
      ...(isVideo
        ? {
            width: 640,
            height: 480,
          }
        : { width: 512, height: 512 }),
    },
    url: data.Key,
  };

  return response;
};

export async function getImagesModRules() {
  const modRules = await fetchThroughCache(
    REDIS_KEYS.CACHES.MOD_RULES.IMAGES,
    async () => {
      const rules = await dbRead.moderationRule.findMany({
        where: { entityType: EntityType.Image, enabled: true },
        select: { id: true, definition: true, action: true, reason: true },
        orderBy: [{ order: 'asc' }],
      });

      return rules.map(({ definition, ...rule }) => ({
        ...rule,
        definition: definition as RuleDefinition,
      }));
    },
    { ttl: CacheTTL.day }
  );

  return modRules;
}

export async function bustImageModRulesCache() {
  await bustFetchThroughCache(REDIS_KEYS.CACHES.MOD_RULES.IMAGES);
}

export const toggleImageFlag = async ({ id, flag }: ToggleImageFlagInput) => {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: { [flag]: true },
  });

  if (!image) throw throwNotFoundError();

  await dbWrite.image.update({
    where: { id },
    data: { [flag]: !image[flag] },
  });

  // Ensure we update the search index:
  await imagesMetricsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

  return true;
};

export const updateImagesFlag = async ({
  ids,
  flag,
  value,
}: Pick<ToggleImageFlagInput, 'flag'> & { ids: number[]; value: boolean }) => {
  if (ids.length === 0) return false;

  await dbWrite.image.updateMany({
    where: { id: { in: ids } },
    data: { [flag]: value },
  });

  // Ensure we update the search index:
  await imagesMetricsSearchIndex.queueUpdate(
    ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );

  return true;
};

export async function refreshImageResources(imageId: number) {
  await dbWrite.$queryRaw`
    DELETE FROM "ImageResourceNew" WHERE "imageId" = ${imageId} AND detected
  `;
  await createImageResources({ imageId });
  // await queueImageSearchIndexUpdate({
  //   ids: [imageId],
  //   action: SearchIndexUpdateQueueAction.Update,
  // });
  return await dbWrite.imageResourceHelper.findMany({ where: { imageId } });
}

export async function addSeenImageIds(imageIds: number[], maxSize = 10000) {
  if (imageIds.length === 0) return;

  const key = REDIS_SYS_KEYS.QUEUES.SEEN_IMAGES;
  const score = Date.now();

  await sysRedis
    .multi()
    .zAdd(
      key,
      imageIds.map((id) => ({ score, value: id.toString() }))
    )
    .zRemRangeByRank(key, 0, -(maxSize + 1))
    .exec()
    .catch((e) => {
      const err = e as Error;
      logToAxiom(
        {
          type: 'search-redis-error',
          error: err.message,
          cause: err.cause,
          stack: err.stack,
        },
        'temp-search'
      ).catch();
    });
}

export async function getSeenImageIds(): Promise<number[]> {
  const key = REDIS_SYS_KEYS.QUEUES.SEEN_IMAGES;
  const ids = await sysRedis.zRange(key, 0, -1, { REV: true });
  return ids.map((id) => parseInt(id, 10));
}

export async function getReportViolationDetailsForImages(
  imageIds: number[]
): Promise<Record<number, { violation?: string; comment?: string; reason?: string }>> {
  if (!imageIds.length) return {};

  const reports = await dbRead.$queryRaw<
    { imageId: number; reason: string; details: Prisma.JsonValue }[]
  >`
    SELECT DISTINCT ON (ir."imageId") ir."imageId", r.reason, r.details
    FROM "Report" r
    JOIN "ImageReport" ir ON ir."reportId" = r.id
    WHERE ir."imageId" IN (${Prisma.join(imageIds)})
      AND r.reason = 'TOSViolation'
    ORDER BY ir."imageId", r."createdAt" DESC
  `;

  const result: Record<number, { violation?: string; comment?: string; reason?: string }> = {};
  for (const report of reports) {
    const details = report.details as Record<string, string> | null;
    result[report.imageId] = {
      violation: details?.violation,
      comment: details?.comment,
      reason: report.reason,
    };
  }
  return result;
}
