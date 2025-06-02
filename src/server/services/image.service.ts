import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import type { ManipulateType } from 'dayjs';
import dayjs from 'dayjs';
import { chunk, lowerFirst, truncate, uniqBy } from 'lodash-es';
import type { SearchParams, SearchResponse } from 'meilisearch';
import type { SessionUser } from 'next-auth';
import { v4 as uuid } from 'uuid';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { VotableTagModel } from '~/libs/tags';
import { clickhouse } from '~/server/clickhouse/client';
import { purgeCache } from '~/server/cloudflare/client';
import { CacheTTL, constants, METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
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
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';
import { metricsSearchClient } from '~/server/meilisearch/client';
import { postMetrics } from '~/server/metrics';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import { leakingContentCounter } from '~/server/prom/client';
import {
  getUserFollows,
  imageMetaCache,
  imageMetadataCache,
  imageMetricsCache,
  imagesForModelVersionsCache,
  tagCache,
  tagIdsForImagesCache,
  thumbnailCache,
  userContentOverviewCache,
} from '~/server/redis/caches';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import type {
  AddOrRemoveImageTechniquesOutput,
  AddOrRemoveImageToolsOutput,
  GetEntitiesCoverImage,
  GetImageInput,
  GetInfiniteImagesOutput,
  GetMyImagesInput,
  ImageEntityType,
  ImageMetaProps,
  ImageModerationSchema,
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
import { collectionSelect } from '~/server/selectors/collection.selector';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import type { ImageResourceHelperModel } from '~/server/selectors/image.selector';
import { imageSelect } from '~/server/selectors/image.selector';
import type { ImageV2Model } from '~/server/selectors/imagev2.selector';
import { imageTagCompositeSelect, simpleTagSelect } from '~/server/selectors/tag.selector';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { upsertImageFlag } from '~/server/services/image-flag.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { createNotification } from '~/server/services/notification.service';
import { bustCachesForPost, updatePostNsfwLevel } from '~/server/services/post.service';
import { bulkSetReportStatus } from '~/server/services/report.service';
import {
  getBlockedTags,
  getModeratedTags,
  getTagsNeedingReview,
} from '~/server/services/system-cache';
import { getVotableTags2 } from '~/server/services/tag.service';
import { upsertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import {
  getBasicDataForUsers,
  getCosmeticsForUsers,
  getProfilePicturesForUsers,
} from '~/server/services/user.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { RuleDefinition } from '~/server/utils/mod-rules';
import { getCursor } from '~/server/utils/pagination-helpers';
import {
  nsfwBrowsingLevelsFlag,
  onlySelectableLevels,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import type { ModelType, ReportReason, ReviewReactions } from '~/shared/utils/prisma/enums';
import {
  Availability,
  BlockImageReason,
  CollectionMode,
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
  EntityType,
  ImageIngestionStatus,
  MediaType,
  ReportStatus,
} from '~/shared/utils/prisma/enums';
import { withRetries } from '~/utils/errorHandling';
import { fetchBlob } from '~/utils/file-utils';
import { getMetadata } from '~/utils/metadata';
import { promptWordReplace } from '~/utils/metadata/audit';
import { removeEmpty } from '~/utils/object-helpers';
import { baseS3Client, imageS3Client } from '~/utils/s3-client';
import { serverUploadImage } from '~/utils/s3-utils';
import { isDefined, isNumber } from '~/utils/type-guards';

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
  // TODO Remove after fallback bucket is deprecated
  if (env.S3_IMAGE_CACHE_BUCKET_OLD) {
    const { items } = await baseS3Client.listObjects({
      bucket: env.S3_IMAGE_CACHE_BUCKET_OLD,
      prefix: url,
    });
    const keys = items.map((x) => x.Key).filter(isDefined);
    if (keys.length) {
      await baseS3Client.deleteManyObjects({
        bucket: env.S3_IMAGE_CACHE_BUCKET_OLD,
        keys,
      });
    }
  }

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

async function markImagesDeleted(id: number | number[]) {
  if (!Array.isArray(id)) id = [id];

  const toSet = Object.fromEntries(id.map((x) => [x, x]));
  await Promise.all([
    sysRedis.packed.hmSet(REDIS_SYS_KEYS.INDEXES.IMAGE_DELETED, toSet),
    sysRedis.hExpire(REDIS_SYS_KEYS.INDEXES.IMAGE_DELETED, Object.keys(toSet), CacheTTL.hour),
  ]);
}

const filterOutDeleted = async <T extends object>(data: (T & { id: number })[]) => {
  const keys = data.map((x) => x.id.toString());
  if (!keys.length) return data;
  const deleted = (
    (await sysRedis.packed.hmGet<number>(REDIS_SYS_KEYS.INDEXES.IMAGE_DELETED, keys)) ?? []
  ).filter(isDefined);
  return data.filter((x) => !deleted.includes(x.id));
};

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

    // Mark as deleted in cache so we filter it out in the future
    await markImagesDeleted(id);

    try {
      if (isProd && !(await imageUrlInUse({ url: image.url, id }))) {
        // TODO Remove after fallback bucket is deprecated
        if (env.S3_IMAGE_UPLOAD_BUCKET_OLD)
          await withRetries(() =>
            baseS3Client.deleteObject({
              bucket: env.S3_IMAGE_UPLOAD_BUCKET_OLD as string,
              key: image.url,
            })
          );
        await withRetries(() =>
          imageS3Client.deleteObject({ bucket: env.S3_IMAGE_UPLOAD_BUCKET, key: image.url })
        );
        await purgeResizeCache({ url: image.url });
      }
    } catch {
      // Ignore errors
    }

    await imagesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
    await imagesMetricsSearchIndex.queueUpdate([
      { id, action: SearchIndexUpdateQueueAction.Delete },
    ]);

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

type AffectedImage = {
  id: number;
  userId: number;
  nsfwLevel: number;
  pHash: bigint;
  postId: number | undefined;
};

const reviewTypeToBlockedReason = {
  csam: BlockImageReason.CSAM,
  minor: BlockImageReason.TOS,
  poi: BlockImageReason.TOS,
  reported: BlockImageReason.TOS,
  blocked: BlockImageReason.TOS,
  tag: BlockImageReason.TOS,
  newUser: BlockImageReason.Ownership,
  appeal: BlockImageReason.TOS,
  modRule: BlockImageReason.TOS,
} as const;

export const reviewTypeToBlockedReasonKeys = Object.keys(reviewTypeToBlockedReason) as [
  string,
  ...string[]
];

export const moderateImages = async ({
  ids,
  needsReview,
  reviewType,
  reviewAction,
  userId,
}: ImageModerationSchema & { userId?: number }) => {
  if (reviewAction === 'delete') {
    const affected = await dbWrite.$queryRaw<AffectedImage[]>`
      SELECT id, "userId", "nsfwLevel", "pHash", "postId"
      FROM "Image"
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

    await queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Delete });

    for (const img of affected) {
      await createNotification({
        userId: img.userId,
        type: 'tos-violation',
        category: NotificationCategory.System,
        key: `tos-violation:image:${uuid()}`,
        details: {
          modelName: img.postId ? `post #${img.postId}` : 'a post',
          entity: 'image',
          url: `/images/${img.id ?? ''}`,
        },
      }).catch();
    }

    await bulkAddBlockedImages({
      data: affected
        .filter((x) => !!x.pHash)
        .map((x) => ({
          hash: x.pHash,
          reason: reviewTypeToBlockedReason[reviewType],
        })),
    });

    return affected;
  } else if (reviewAction === 'removeName') {
    await removeNameReference(ids);
    await queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Update });
  } else if (reviewAction === 'mistake') {
    // Remove needsReview status
    await dbWrite.image.updateMany({
      where: { id: { in: ids } },
      data: {
        needsReview: null,
        ingestion: 'Scanned',
        poi: reviewType === 'poi' ? false : undefined,
        minor: reviewType === 'minor' ? false : undefined,
      },
    });
    await queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Update });
  } else {
    const isMinor = reviewType === 'minor';
    // Approve
    await dbWrite.$queryRaw`
        UPDATE "Image" SET
          "needsReview" = ${needsReview},
          "blockedFor" = NULL,
          -- Remove ruleId and ruleReason from metadata
          "metadata" = "metadata" - 'ruleId' - 'ruleReason',
          "ingestion" = 'Scanned',

          ${
            isMinor
              ? Prisma.sql`"minor" = CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE END,`
              : Prisma.sql``
          }
          -- if image was created within 72 hrs, set scannedAt to now
          "scannedAt" = CASE
              WHEN "createdAt" > NOW() - INTERVAL '3 day' THEN NOW()
              ELSE "scannedAt"
            END
        WHERE id IN (${Prisma.join(ids)});
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

    const toUpdate = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
        SELECT "imageId", "tagId"
        FROM "TagsOnImageDetails"
        WHERE "imageId" IN (${Prisma.join(ids)}) AND "tagId" IN (${Prisma.join(tagIds)})
      `;

    if (toUpdate.length) {
      await upsertTagsOnImageNew(
        toUpdate.map(({ imageId, tagId }) => ({
          imageId,
          tagId,
          disabled: true,
          needsReview: false,
        }))
      );
    } else {
      await dbWrite.$executeRawUnsafe(
        `SELECT update_nsfw_levels_new(ARRAY[${ids.join(',')}]::integer[])`
      );
    }

    await queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Update });
  }
  return null;
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
  return await dbWrite.image.findUnique({
    where: { id },
    select: {
      resources: {
        select: {
          id: true,
          modelVersion: { select: { id: true, name: true } },
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

const scanner = env.EXTERNAL_IMAGE_SCANNER;
const clavataScan = env.CLAVATA_SCAN;
const scanTypes: ImageScanType[] = [ImageScanType.WD14, ImageScanType.Hash];
if (clavataScan !== 'off' || scanner === 'clavata') scanTypes.push(ImageScanType.Clavata);
if (scanner === 'hive') scanTypes.push(ImageScanType.Hive);

export const ingestImage = async ({
  image,
  tx,
}: {
  image: IngestImageInput;
  tx?: Prisma.TransactionClient;
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

  const response = await fetch(env.IMAGE_SCANNING_ENDPOINT + '/enqueue', {
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
      scans: scanTypes,
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
          scans: scans ?? scanTypes,
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
  username: string | null;
  userImage: string | null;
  deletedAt: Date | null;
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
    disablePoi,
    disableMinor,
  } = input;
  let { browsingLevel, userId: targetUserId } = input;

  const AND: Prisma.Sql[] = [Prisma.sql`i."postId" IS NOT NULL`];
  const WITH: Prisma.Sql[] = [];
  let orderBy: string;
  // const cacheTags: string[] = [];
  // let cacheTime = CacheTTL.xs;
  const userId = user?.id;
  const isModerator = user?.isModerator ?? false;
  const includeCosmetics = include?.includes('cosmetics'); // TODO: This must be done similar to user cosmetics.

  // nb - test code
  // if (modelVersionId) {
  //   const shouldBypassSort = JSON.parse((await redis.get('bypassSort')) ?? '[]') as number[];
  //   if (shouldBypassSort.includes(modelVersionId)) sort = ImageSort.Newest;
  // }

  // Exclude unselectable browsing levels
  browsingLevel = onlySelectableLevels(browsingLevel);

  if (hidden) {
    if (!userId) throw throwAuthorizationError();
    const hiddenImages = await dbRead.imageEngagement.findMany({
      where: { userId, type: 'Hide' },
      select: { imageId: true },
    });
    const imageIds = hiddenImages.map((x) => x.imageId);
    if (imageIds.length) {
      // cacheTime = 0;
      AND.push(Prisma.sql`i."id" IN (${Prisma.join(imageIds)})`);
    } else {
      return { items: [], nextCursor: undefined };
    }
  }

  if (username && !targetUserId) {
    const targetUser = await dbRead.user.findUnique({ where: { username }, select: { id: true } });
    if (!targetUser) throw new Error('User not found');
    targetUserId = targetUser.id;
  }

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

  let from = 'FROM "Image" i';
  const joins: string[] = [];
  // Filter to specific model/review content
  const prioritizeUser = !!prioritizedUserIds?.length; // [x]
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
      // Prisma.sql`(u."id" = ${targetUserId} OR i."postId" IN (SELECT id FROM collaboratingPosts))`
      Prisma.sql`u."id" = ${targetUserId}`
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
  if (userId && followed) {
    const userIds = await getUserFollows(userId);
    if (userIds.length) {
      // cacheTime = 0;
      AND.push(Prisma.sql`i."userId" IN (${Prisma.join(userIds)})`);
    }
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
    // if (userId) cacheTime = 0;
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
                  (c.metadata::json->'submissionsHiddenUntilEndDate') IS NULL
                  OR (c.metadata::json->'submissionsHiddenUntilEndDate')::TEXT = 'null'
                  OR (c.metadata::json->'submissionsHiddenUntilEndDate')::TEXT = 'false'
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
    // else if (sort === ImageSort.MostTipped) {
    //   orderBy = `im."tippedAmountCount" DESC, im."reactionCount" DESC, im."imageId"`;
    //   if (!isGallery) AND.push(Prisma.sql`im."tippedAmountCount" > 0`);
    // }
    if (sort === ImageSort.Random) orderBy = 'ct."randomId" DESC';
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
      orderBy = `(i."postId" * 100) + i."index"`; // Order by oldest post first
    }
  }

  if (userId && !!reactions?.length) {
    // cacheTime = 0;
    joins.push(`JOIN "ImageReaction" ir ON ir."imageId" = i.id`);
    AND.push(Prisma.sql`ir.reaction IN (${Prisma.join(reactions)})`);
    AND.push(Prisma.sql`ir."userId" = ${userId}`);
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
    JOIN "User" u ON u.id = i."userId"
    JOIN "Post" p ON p.id = i."postId"
    ${Prisma.raw(WITH.length && collectionId ? `JOIN ct ON ct."imageId" = i.id` : '')}
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  const engines = Object.keys(videoGenerationConfig2);
  const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;
  const query = Prisma.sql`
    ${queryWith}
    SELECT
      ${(reactions?.length ?? 0) > 0 ? Prisma.sql`DISTINCT ` : Prisma.sql``} i.id,
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
          WHEN i.meta->>'civitaiResources' IS NOT NULL
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
      u.username,
      u.image "userImage",
      u."deletedAt",
      p."availability",
      i.minor,
      i.poi,
      i."acceptableMinor",
      ${Prisma.raw(
        include.includes('metaSelect')
          ? '(CASE WHEN i."hideMeta" = TRUE THEN NULL ELSE i.meta END) as "meta",'
          : ''
      )}
      ${Prisma.raw(
        includeBaseModel
          ? `(
            SELECT mv."baseModel"
            FROM "ImageResourceNew" ir
            LEFT JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
            LEFT JOIN "Model" m ON mv."modelId" = m.id
            WHERE m."type" = 'Checkpoint' AND ir."imageId" = i.id
            LIMIT 1
          ) "baseModel",`
          : ''
      )}
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
    tagIdsVar = await tagIdsForImagesCache.fetch(imageIds);
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

  const videoIds = rawImages.filter((x) => x.type === MediaType.video).map((x) => x.id);
  const thumbnails = await getThumbnailsForImages(videoIds);

  const now = new Date();
  const filtered = rawImages.filter((x) => {
    if (isModerator) return true;
    // if (x.needsReview && x.userId !== userId) return false;
    if ((!x.publishedAt || x.publishedAt > now || !!x.unpublishedAt) && x.userId !== userId)
      return false;
    // if (x.ingestion !== 'Scanned' && x.userId !== userId) return false;
    return true;
  });

  const imageMetrics = await getImageMetricsObject(filtered);

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
  > = filtered.map(
    ({ userId: creatorId, username, userImage, deletedAt, cursorId, unpublishedAt, ...i }) => {
      const match = imageMetrics[i.id];
      const thumbnail = thumbnails[i.id];

      return {
        ...i,
        nsfwLevel: Math.max(thumbnail?.nsfwLevel ?? 0, i.nsfwLevel),
        modelVersionIds: [], // TODO doing this basically just for TS
        modelVersionIdsManual: [],
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
        reactions:
          userReactions?.[i.id]?.map((r) => ({ userId: userId as number, reaction: r })) ?? [],
        tags: tagsVar?.filter((x) => x.imageId === i.id),
        tagIds: tagIdsVar?.[i.id]?.tags,
        cosmetic: cosmetics?.[i.id] ?? null,
        thumbnailUrl: thumbnail?.url,
      };
    }
  );

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

  const { data: searchResultsTmp, nextCursor: searchNextCursor } = await getImagesFromSearch({
    ...input,
    currentUserId,
    isModerator: user?.isModerator,
    offset,
    entry,
  });

  const searchResults = await filterOutDeleted(searchResultsTmp);

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
      publishedAt: !publishedAtUnix ? undefined : sr.sortAt,
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

type ImageSearchInput = GetAllImagesInput & {
  currentUserId?: number;
  isModerator?: boolean;
  offset?: number;
  entry?: number;
  // Unhandled
  //prioritizedUserIds?: number[];
  //userIds?: number | number[];
  //modelId?: number;
  //reviewId?: number;
};

async function getImagesFromSearch(input: ImageSearchInput) {
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
    //
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
    // TODO check the unused stuff in here
  } = input;
  let { browsingLevel, userId } = input;

  const sorts: MeiliImageSort[] = [];
  const filters: string[] = [];

  if (!isModerator) {
    filters.push(
      // Avoids exposing private resources to the public
      `((NOT availability = ${Availability.Private}) OR "userId" = ${currentUserId})`
    );

    filters.push(
      // Avoids blocked resources to the public
      `(("blockedFor" IS NULL OR "blockedFor" NOT EXISTS) OR "userId" = ${currentUserId})`
    );
  }

  if (postId) {
    postIds = [...(postIds ?? []), postId];
  }

  if (disablePoi) {
    filters.push(`(NOT poi = true OR "userId" = ${currentUserId})`);
  }
  if (disableMinor) {
    filters.push(`(NOT minor = true)`);
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
      { type: 'search-warning', message: 'Using username instead of userId' },
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
  if (isModerator) browsingLevels.push(0);

  const nsfwLevelField: MetricsImageFilterableAttribute = useCombinedNsfwLevel
    ? 'combinedNsfwLevel'
    : 'nsfwLevel';
  const nsfwFilters = [
    makeMeiliImageSearchFilter(nsfwLevelField, `IN [${browsingLevels.join(',')}]`) as string,
  ];
  const nsfwUserFilters = [
    makeMeiliImageSearchFilter(nsfwLevelField, `= 0`),
    makeMeiliImageSearchFilter('userId', `= ${currentUserId}`),
  ];
  // if (pending) {}
  nsfwFilters.push(`(${nsfwUserFilters.join(' AND ')})`);
  filters.push(`(${nsfwFilters.join(' OR ')})`);

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
    const publishedFilters = [makeMeiliImageSearchFilter('publishedAtUnix', `<= ${Date.now()}`)];
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
  if (afterDate) filters.push(makeMeiliImageSearchFilter('sortAtUnix', `> ${afterDate.getTime()}`));

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
    logToAxiom(
      { type: 'cant-use-search', input: JSON.stringify(missingKeys) },
      'temp-search'
    ).catch();
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
      filters.push(makeMeiliImageSearchFilter('sortAtUnix', `<= ${entry}`));
    }
  }
  sorts.push(searchSort);
  sorts.push(makeMeiliImageSearchSort('id', 'desc')); // secondary sort for consistency

  const request: SearchParams = {
    filter: filters.join(' AND '),
    sort: sorts,
    limit: limit + 1,
    offset,
  };

  try {
    // TODO switch to DocumentsResults, DocumentsResults and .getDocuments, no search
    const results: SearchResponse<ImageMetricsSearchIndexRecord> = await metricsSearchClient
      .index(METRICS_SEARCH_INDEX)
      .search(null, request);

    let nextCursor: number | undefined;
    if (results.hits.length > limit) {
      results.hits.pop();
      // - if we have no entrypoint, it's the first request, and set one for the future
      //   else keep it the same
      nextCursor = !entry ? results.hits[0]?.sortAtUnix : entry;
    }

    const includesNsfwContent = Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag);
    const filteredHits = results.hits.filter((hit) => {
      if (hit.id === 17383305) {
        console.log('hit', hit);
      }
      if (!hit.url)
        // check for good data
        return false;
      // filter out items flagged with minor unless it's the owner or moderator
      if (hit.acceptableMinor) return hit.userId === currentUserId || isModerator;
      // filter out non-scanned unless it's the owner or moderator
      if (![0, NsfwLevel.Blocked].includes(hit.nsfwLevel) && !hit.needsReview) return true;

      return hit.userId === currentUserId || (isModerator && includesNsfwContent);
    });

    const filteredHitIds = filteredHits.map((fh) => fh.id);
    // we could pull in nsfwLevel/needsReview here too and overwrite the search index attributes (move above the hits filter)
    const dbIdResp = await dbRead.image.findMany({
      where: { id: { in: filteredHitIds } },
      select: { id: true },
    });
    const dbIds = dbIdResp.map((dbi) => dbi.id);
    const filtered = filteredHits.filter((fh) => dbIds.includes(fh.id));

    // TODO maybe grab more if the number is now too low?

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

    if (fullData.length) {
      sysRedis.packed
        .sAdd(
          REDIS_SYS_KEYS.QUEUES.SEEN_IMAGES,
          fullData.map((i) => i.id)
        )
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
    return { data: [], nextCursor: undefined };
  }
}

const getImageMetricsObject = async (data: { id: number }[]) => {
  let imageMetrics: AsyncReturnType<typeof getImageMetrics> = {};
  try {
    imageMetrics = await getImageMetrics(data.map((d) => d.id));
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
  }
  return imageMetrics;
};

const getImageMetrics = async (ids: number[]) => {
  if (!ids.length) return {};

  const metricsData = await imageMetricsCache.fetch(ids);
  type PgDataType = (typeof metricsData)[number];

  // - get images with no data at all
  const missingIds = ids.filter((i) => !metricsData[i]);
  // - get images where some of the properties are null
  const missingData = Object.values(metricsData)
    .filter((d) => Object.values(d).some((v) => !isDefined(v)))
    .map((x) => x.imageId);
  const missing = [...new Set([...missingIds, ...missingData])];

  let clickData: DeepNonNullable<PgDataType>[] = [];
  // - If missing data in postgres, get latest from clickhouse
  if (missing.length > 0) {
    if (clickhouse) {
      // - find the missing IDs' data in clickhouse
      clickData = await withRetries(
        () =>
          clickhouse!.$query<DeepNonNullable<PgDataType>>(`
          SELECT entityId                                              as "imageId",
                 SUM(if(metricType = 'ReactionLike', metricValue, 0))  as "reactionLike",
                 SUM(if(metricType = 'ReactionHeart', metricValue, 0)) as "reactionHeart",
                 SUM(if(metricType = 'ReactionLaugh', metricValue, 0)) as "reactionLaugh",
                 SUM(if(metricType = 'ReactionCry', metricValue, 0))   as "reactionCry",
                 -- SUM(if(
                 --         metricType in ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry'), metricValue, 0
                 --     ))                                                as "reactionTotal",
                 SUM(if(metricType = 'Comment', metricValue, 0))       as "comment",
                 SUM(if(metricType = 'Collection', metricValue, 0))    as "collection",
                 SUM(if(metricType = 'Buzz', metricValue, 0))          as "buzz"
          FROM entityMetricEvents
          WHERE entityType = 'Image'
            AND entityId IN (${missing.join(',')})
          GROUP BY imageId
        `),
        3,
        300
      );

      // - if there is nothing at all in clickhouse, fill this with zeroes
      const missingClickIds = missingIds.filter(
        (i) => !clickData.map((c) => c.imageId).includes(i)
      );
      for (const mci of missingClickIds) {
        clickData.push({
          imageId: mci,
          reactionLike: 0,
          reactionHeart: 0,
          reactionLaugh: 0,
          reactionCry: 0,
          comment: 0,
          collection: 0,
          buzz: 0,
        });
      }

      // TODO if we somehow have some data in PG but none at all in CH, these datapoints won't get resolved
      const missingClickData = missingData.filter(
        (i) => !clickData.map((c) => c.imageId).includes(i)
      );
      if (missingClickData.length) {
        if (isProd)
          logToAxiom(
            {
              type: 'info',
              name: 'Missing datapoints in clickhouse',
              details: {
                ids: missingClickData,
              },
            },
            'clickhouse'
          ).catch();
      }

      const dataToInsert = clickData
        .map((cd) =>
          [
            EntityMetric_MetricType_Type.ReactionLike,
            EntityMetric_MetricType_Type.ReactionHeart,
            EntityMetric_MetricType_Type.ReactionLaugh,
            EntityMetric_MetricType_Type.ReactionCry,
            EntityMetric_MetricType_Type.Comment,
            EntityMetric_MetricType_Type.Collection,
            EntityMetric_MetricType_Type.Buzz,
          ].map((mt) => ({
            entityType: EntityMetric_EntityType_Type.Image,
            entityId: cd.imageId,
            metricType: mt,
            metricValue: cd[lowerFirst(mt) as keyof typeof cd],
          }))
        )
        .flat();

      try {
        await dbWrite.entityMetric.createMany({
          data: dataToInsert,
          skipDuplicates: true,
        });
      } catch (e) {
        const error = e as Error;
        logToAxiom(
          {
            type: 'error',
            name: 'Failed to insert EntityMetric cache',
            message: error.message,
            stack: error.stack,
            cause: error.cause,
          },
          'clickhouse'
        ).catch();
      }
    } else {
      logToAxiom(
        {
          type: 'error',
          name: 'No clickhouse client - fetch',
        },
        'clickhouse'
      ).catch();
    }
  }

  return [...Object.values(metricsData), ...clickData].reduce((acc, row) => {
    const { imageId, ...rest } = row;
    acc[imageId] = Object.fromEntries(
      Object.entries(rest).map(([k, v]) => [k, isDefined(v) ? Math.max(0, v) : v])
    ) as Omit<PgDataType, 'imageId'>;
    return acc;
  }, {} as { [p: number]: Omit<PgDataType, 'imageId'> });
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
          WHEN i.meta->>'civitaiResources' IS NOT NULL
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
          WHEN i.meta->>'civitaiResources' IS NOT NULL
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
}: {
  postIds: number | number[];
  // excludedIds?: number[];
  coverOnly?: boolean;
  browsingLevel?: number;
  user?: SessionUser;
  pending?: boolean;
  disablePoi?: boolean;
  disableMinor?: boolean;
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
          WHEN i.meta->>'civitaiResources' IS NOT NULL
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
    ORDER BY i.index ASC
  `;
  const imageIds = images.map((i) => i.id);
  const tagIds = await tagIdsForImagesCache.fetch(imageIds);
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

  const imageMetrics = await getImageMetricsObject(images);

  return images.map((i) => {
    const match = imageMetrics[i.id];
    return {
      ...i,
      tagIds: tagIds[i.id]?.tags,
      reactions: userReactions?.[i.id] ?? [],

      likeCount: match?.reactionLike ?? 0,
      laughCount: match?.reactionLaugh ?? 0,
      heartCount: match?.reactionHeart ?? 0,
      cryCount: match?.reactionCry ?? 0,

      commentCount: match?.comment ?? 0,
      collectedCount: match?.collection ?? 0,
      tippedAmountCount: match?.buzz ?? 0,

      dislikeCount: 0,
      viewCount: 0,
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
    });
  }

  await userContentOverviewCache.bust(image.userId);

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
      t."entityType"
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
          JOIN "Image" i ON i."postId" = p.id
          WHERE e."entityType" = 'Post'
            AND p."publishedAt" IS NOT NULL
            AND i."ingestion" = 'Scanned'
            AND i."needsReview" IS NULL
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
      JOIN "ModActivity" ma ON ma."entityId" = i.id AND ma."entityType" = 'image'
      JOIN "User" mu ON mu.id = ma."userId"
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
export const getImageModerationReviewQueue = async ({
  limit,
  cursor,
  needsReview,
  tagReview,
  reportReview,
  tagIds,
  browsingLevel,
}: ImageReviewQueueInput) => {
  const AND: Prisma.Sql[] = [];

  AND.push(Prisma.sql`(i."nsfwLevel" & ${browsingLevel}) != 0`);

  if (needsReview) {
    AND.push(Prisma.sql`i."needsReview" = ${needsReview}`);
  }

  if (tagIds?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "TagsOnImageDetails" toi
      WHERE toi."imageId" = i.id AND toi."tagId" IN (${Prisma.join(tagIds)})
    )`);
  }

  // Order by oldest first. This is to ensure that images that have been in the queue the longest
  // are reviewed first.
  let orderBy = `i."id" DESC`;

  let cursorProp = 'i."id"';
  let cursorDirection = 'DESC';

  if (tagReview) {
    AND.push(Prisma.sql`i.id IN (SELECT DISTINCT "imageId" FROM tags_review LIMIT ${limit + 1})`);
    AND.push(Prisma.sql`
      i."nsfwLevel" < ${NsfwLevel.Blocked}
    `);
  } else {
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
  }

  // TODO: find a better way to handle different select/join for each type of review
  const queryKey = reportReview ? 'report' : (needsReview as AdditionalQueryKey);
  const additionalQuery = queryKey ? imageReviewQueueJoinMap[queryKey] : undefined;

  const rawImages = await dbRead.$queryRaw<GetImageModerationReviewQueueRaw[]>`
    ${Prisma.raw(
      tagReview
        ? `WITH tags_review AS (
            SELECT
              toi."imageId"
            FROM "TagsOnImageNew" toi  JOIN "Image" i ON toi."imageId" = i.id
            WHERE
            (toi."attributes" >> 9) & 1 = 1
            AND (toi."attributes" >> 10) & 1 != 1
            AND i."nsfwLevel" < 32
            ${cursor ? `AND "imageId" <= ${cursor}` : ''}
            ORDER BY (toi."imageId", toi."tagId") DESC
          )`
        : ''
    )}
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
      FROM "TagsOnImageNew" toi
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

async function removeNameReference(images: number[]) {
  const tasks = chunk(images, 500).map((images) => async () => {
    // Get images to de-reference
    const [targets, prompts] = await Promise.all([
      await dbRead.$queryRaw<NameReference[]>`
        SELECT
          toi."imageId",
          t.id as "tagId",
          t.name
        FROM "TagsOnImageNew" toi
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
      DELETE FROM "TagsOnImageNew" toi
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
  userId,
  status,
  isModerator,
}: UpdateImageNsfwLevelOutput & { userId: number; isModerator?: boolean }) {
  if (!nsfwLevel) throw throwBadRequestError();
  if (isModerator) {
    await dbWrite.image.update({ where: { id }, data: { nsfwLevel, nsfwLevelLocked: true } });
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
      activity: 'setNsfwLevel',
    });
  } else {
    // Track potential content leaking
    // If the image is currently PG and the new level is R or higher, and the image isn't from the original user, increment the counter
    const current = await dbWrite.image.findFirst({
      where: { id },
      select: { nsfwLevel: true, userId: true },
    });
    if (!current) return;
    if (
      current?.nsfwLevel === NsfwLevel.PG &&
      nsfwLevel >= NsfwLevel.R &&
      current?.userId !== userId
    ) {
      leakingContentCounter.inc();
    }

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

  const results = await dbRead.$queryRaw<ImageRatingRequestResponse[]>`
      WITH image_rating_requests AS (
        SELECT
          "imageId",
          COALESCE(SUM(weight),0) total,
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
        ${!!cursor ? Prisma.sql` AND irr."createdAt" >= ${new Date(cursor)}` : Prisma.sql``}
      ORDER BY irr."createdAt"
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

  const { rows: resources } = await pgDbRead.query<{
    imageId: number;
    modelVersionId: number;
    strength?: number;
    modelId: number;
    modelName: string;
    modelType: ModelType;
    versionId: number;
    versionName: string;
    baseModel: string;
  }>(Prisma.sql`
    SELECT
      ir."imageId",
      ir."modelVersionId",
      ir.strength,
      m.id as "modelId",
      m.name as "modelName",
      m.type as "modelType",
      mv.id as "versionId",
      mv.name as "versionName",
      mv."baseModel" as "baseModel"
    FROM "ImageResourceNew" ir
    JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
    JOIN "Model" m on mv."modelId" = m.id
      WHERE ir."imageId" = ${id}
  `);

  const parsedMeta = imageMetaOutput.safeParse(image.meta);
  const data = parsedMeta.success ? parsedMeta.data : {};
  const { 'Clip skip': legacyClipSkip, clipSkip = legacyClipSkip, external, ...rest } = data;
  const meta =
    parsedMeta.success && !image.hideMeta ? removeEmpty({ ...rest, clipSkip }) : undefined;

  let onSite = false;
  let process: string | undefined | null = undefined;
  let hasControlNet = false;
  if (meta) {
    if ('civitaiResources' in meta) onSite = true;
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

export const getImageContestCollectionDetails = async ({
  id,
  userId,
}: { userId?: number } & GetByIdInput) => {
  const items = await dbRead.collectionItem.findMany({
    where: {
      collection: {
        mode: CollectionMode.Contest,
      },
      imageId: id,
    },
    select: {
      id: true,
      imageId: true,
      status: true,
      createdAt: true,
      reviewedAt: true,
      collection: { select: collectionSelect },
      scores: { select: { userId: true, score: true } },
      tag: true,
    },
  });

  const permissions = await Promise.all(
    items.map(async (item) => {
      const permissions = await getUserCollectionPermissionsById({
        id: item.collection.id as number,
        userId,
      });

      return permissions;
    })
  );

  return items.map((i) => ({
    ...i,
    permissions: permissions.find((p) => p.collectionId === i.collection.id),
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

export async function bulkRemoveBlockedImages({
  ids,
  hashes,
}: {
  hashes?: bigint[] | number[];
  ids?: number[];
}) {
  if (ids) {
    const images = await dbWrite.image.findMany({
      where: { id: { in: ids } },
      select: { pHash: true },
    });

    hashes = images.map((i) => i.pHash as bigint).filter(isDefined);
  }

  if (!hashes?.length) return;

  return dbWrite.blockedImage.deleteMany({ where: { hash: { in: hashes } } });
}

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
