import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import type { ManipulateType } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';
import { chunk, isEqual, truncate, uniq, uniqBy } from 'lodash-es';
import { MeiliSearch, type SearchParams } from 'meilisearch';
import type { SessionUser } from '~/types/session';
import { v4 as uuid } from 'uuid';
import { isDev, isProd } from '~/env/other';
import { env } from '~/env/server';
import type { VotableTagModel } from '~/libs/tags';
import { clickhouse } from '~/server/clickhouse/client';
import { toClickhouseInt64 } from '~/server/clickhouse/int64';
import { purgeCache } from '~/server/cloudflare/client';
import {
  CacheTTL,
  constants,
  METRICS_IMAGES_SEARCH_INDEX,
  nsfwRestrictedBaseModels,
} from '~/server/common/constants';
import { imageReviewedSql } from '~/server/common/image-visibility';
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
import {
  getDbWithoutLag,
  getDbWithoutLagBatch,
  preventReplicationLag,
} from '~/server/db/db-lag-helpers';
import { datapacketDbRead } from '~/server/db/datapacketDb';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import {
  dailyChallengeConfig,
  parseJudgeScore,
  type JudgeScore,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { poolCounters } from '~/server/games/new-order/utils';
import { logToAxiom, safeError } from '~/server/logging/client';
import { withSpan } from '~/server/utils/otel-helpers';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import {
  FETCH_DOCUMENTS_TIMEOUT_MESSAGE,
  MEILI_FETCH_FAILFAST_REASON_CIRCUIT_OPEN,
  MeiliCallTimeoutError,
  MeilisearchFetchError,
  SEARCH_ACTOR_HEADER,
  failfastReasonForStatus,
  failfastReasonForTransientError,
  fetchDocumentsAbortable,
  getMetricsSearchClient,
  isFailfastStatus,
  isTransientMeiliError,
  meiliFetchFailfastTotal,
  metricsSearchClient,
  withMeili,
  wrapMeilisearchClientWithLimiter,
} from '~/server/meilisearch/client';
import { postMetrics } from '~/server/metrics';
import {
  clickhouseFailSoftCounter,
  imageScanSubmittedCounter,
  leakingContentCounter,
  registerCounter,
  registerCounterWithLabels,
} from '~/server/prom/client';
import { getNewCreatorUserIds } from '~/server/services/new-creators.service';
import { imageOnSiteSql, isImageMetaOnSite } from '~/server/utils/image-onsite';
import { stripImageForInfiniteWire } from '~/server/utils/image-infinite-wire';
import { deriveUnmatchedResources } from '~/server/utils/unmatched-resources';
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
} from '~/server/redis/caches';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import {
  redis,
  REDIS_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { createCachedObject, queryCacheRaw } from '~/server/utils/cache-helpers';
import { createLruCache } from '~/server/utils/lru-cache';
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
  ImageModerationBlockSchema,
  ImageModerationSchema,
  ImageModerationUnblockSchema,
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
} from '~/server/services/collection.service';
import {
  enqueueCollectionRebuild,
  getCollectionIdsForImages,
} from '~/server/services/collection-media-index';
import { enforceBlockedBrowsingTags } from '~/server/services/blocked-browsing-tags.service';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import {
  getVisibleModel3DIdForPost,
  getVisibleModel3DIds,
} from '~/server/services/model3d.service';
import { addImageToQueue } from '~/server/services/games/new-order.service';
import { upsertImageFlag } from '~/server/services/image-flag.service';
import { parseScannerFlag } from '~/server/services/image-scanner-flag';
import {
  deleteImagTagsForReviewByImageIds,
  getImagTagsForReviewByImageIds,
} from '~/server/services/image-review.service';
import type { ImageModActivity } from '~/server/services/moderator.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { createNotification } from '~/server/services/notification.service';
import {
  queueComicsForPanelImages,
  updateModel3DNsfwLevelForThumbnailImage,
} from '~/server/services/nsfwLevels.service';
import { bustCachesForPosts, updatePostNsfwLevel } from '~/server/services/post.service';
import { bulkSetReportStatus, resolveEntityAppeal } from '~/server/services/report.service';
import { upsertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import {
  getBasicDataForUsers,
  getCosmeticsForUsers,
  getProfilePicturesForUsers,
} from '~/server/services/user.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { Limiter, limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  isClickHouseConnectionError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwInternalServerError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import type { RuleDefinition } from '~/server/utils/mod-rules';
import { getCursor } from '~/server/utils/pagination-helpers';
import {
  nsfwBrowsingLevelsArray,
  nsfwBrowsingLevelsFlag,
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type {
  CollectionItemRejectionReason,
  DomainColor,
  ModelType,
  ReportReason,
  ReviewReactions,
  TagType,
} from '~/shared/utils/prisma/enums';
import {
  Availability,
  BlockImageReason,
  CollectionItemStatus,
  CollectionMode,
  AppealStatus,
  EntityType,
  ImageIngestionStatus,
  JobQueueType,
  MediaType,
  NewOrderRankType,
  ReportStatus,
} from '~/shared/utils/prisma/enums';
import {
  classifyImageScanFailure,
  ImageScanFailureClass,
} from '~/server/services/image-scan-failure';
import { withRetries } from '~/utils/errorHandling';
import { fetchBlob } from '~/utils/file-utils';
import { getMetadata } from '~/utils/metadata';
import { removeEmpty } from '~/utils/object-helpers';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { serverUploadImage, getB2ImageS3Client } from '~/utils/s3-utils';
import { resolveMediaLocation } from '~/server/services/storage-resolver';
import { isDefined, isNumber } from '~/utils/type-guards';
import { FLIPT_FEATURE_FLAGS, getFliptBoolean, isFlipt } from '../flipt/client';
import { ensureRegisterFeedImageExistenceCheckMetrics } from '../metrics/feed-image-existence-check.metrics';
import client from 'prom-client';
import { getExplainSql, queryWithTimeout } from '~/server/db/db-helpers';
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
import { getGenerationDisplayKeys } from '~/server/services/orchestrator/legacy-metadata-mapper';
import {
  sanitizeProvenance,
  storedSourceImageIds,
} from '~/server/services/orchestrator/remix-provenance';

const {
  cacheHitRequestsTotal,
  ffRequestsTotal,
  requestDurationSeconds,
  requestTotal,
  droppedIdsTotal,
  postFilterIterations,
  postFilterDocsProcessed,
  postFilterFilterRatio,
} = ensureRegisterFeedImageExistenceCheckMetrics(client.register);

// no user should have to see images on the site that haven't been scanned or are queued for removal

/**
 * How much of an image's cached variants the invalidation may remove.
 *
 * - `all` — every cached variant. For a DELETE, where the image must stop serving entirely.
 * - `hidden-meta-orphans` — only the variants produced BEFORE a `hideMeta` flip.
 *
 * The second scope exists because a `hideMeta` false→true flip re-keys the image: the cache key
 * includes the hideMeta flag, so after the flip every request derives a fresh, metadata-stripped
 * variant under a NEW key and the pre-flip ones become orphans. The image is still LIVE, so
 * removing the whole set would evict variants the page is currently serving; removing only the
 * orphans clears the metadata-bearing copies without touching anything in use.
 */
export type PurgeResizeCacheScope = 'all' | 'hidden-meta-orphans';

export async function purgeResizeCache({
  url,
  scope = 'all',
}: {
  url: string;
  scope?: PurgeResizeCacheScope;
}) {
  // Invalidate the resized/converted variants for this image. Cache
  // invalidation only — a stale variant is self-healing (re-derived on next
  // request) and must never fail the caller's mutation.
  //
  // NOTE: this used to also do a direct S3 listObjects+deleteManyObjects against
  // env.S3_IMAGE_CACHE_BUCKET ("civitai-media-cache") via the legacy image S3 client.
  // That path was DEAD in prod and has been removed: the cache bucket now lives
  // on Backblaze B2 (us-west-004) and is owned by the image-cacher service,
  // while that client pointed at the DigitalOcean-Spaces object-read proxy
  // (S3_IMAGE_UPLOAD_ENDPOINT). That proxy does not implement ListObjectsV2 — a
  // path-style list request returns a plain-text "404 page not found", which the
  // AWS SDK's XML error deserializer chokes on (`char '4' is not expected.:1:1`).
  // So the listObjects call ALWAYS threw before deleting anything (fire ~9/min,
  // fail-soft since #2600) — pure noise + a wasted round-trip on every image
  // delete / hideMeta toggle. Invalidation is fully handled by the image-cacher
  // /admin/invalidate call below (L2 Redis SCAN+DEL by prefix + Cloudflare tag
  // purge), which is the modern owner of the civitai-media-cache bucket.

  // Best-effort: tell image-cacher to invalidate its caches for this UUID.
  // If this fails (network, image-cacher down, etc.) we accept up to 4d of
  // stale L2 entries — no worse than today's behavior. Never block or throw
  // the delete flow.
  if (env.IMAGE_CACHER_URL && url) {
    // `keep=hm` asks the service to retain the post-flip (hideMeta) variants. Omitted entirely for
    // the `all` scope so this call is byte-identical to the one that has always been sent.
    // Exhaustive on purpose. A ternary here fails OPEN: any value that is not the exact literal
    // degrades to the WIDEST blast radius, so adding a third scope later would silently mean
    // "delete everything" instead of failing to compile. The counterpart service rejects an
    // unrecognised value outright; this is the client-side half of the same stance.
    const keepParam = ((): string => {
      switch (scope) {
        case 'all':
          return '';
        case 'hidden-meta-orphans':
          return '&keep=hm';
        default: {
          const unreachable: never = scope;
          throw new Error(`unhandled purgeResizeCache scope: ${String(unreachable)}`);
        }
      }
    })();

    const query = `imageKey=${encodeURIComponent(url)}${keepParam}`;

    // The endpoint requires this header once its destructive mode is enabled, and rejects the
    // call outright without it. Sending it whenever it is configured means enabling that mode is
    // a change on ONE side, not a synchronised deploy across two services.
    const headers: Record<string, string> = {};
    if (env.IMAGE_CACHER_ADMIN_SECRET) {
      headers['X-Admin-Secret'] = env.IMAGE_CACHER_ADMIN_SECRET;
    }

    fetch(`${env.IMAGE_CACHER_URL}/admin/invalidate?${query}`, {
      method: 'POST',
      headers,
      // Never follow a redirect while carrying the shared secret. `fetch` strips Authorization and
      // Cookie on a cross-origin hop but forwards CUSTOM headers verbatim, so a 30x from this
      // endpoint would hand X-Admin-Secret to wherever it pointed. It only ever answers
      // 202/400/401, so a redirect here is already anomalous — fail instead of chasing it.
      redirect: 'error',
      // Invalidation must not slow down the delete flow.
      signal: AbortSignal.timeout(2000),
    })
      .then((res) => {
        // 🔴 `fetch` DOES NOT REJECT ON A NON-2xx. Without this branch a 401 (missing/most likely
        // stale shared secret), a 409 refusal or a 503 partial failure all land in the success
        // path and vanish — so invalidation could stop working COMPLETELY and produce not one log
        // line. That is the failure mode this check exists for, not a hypothetical one: the
        // service's auth gate switches on when its delete mode is enabled, and the first symptom
        // of a secret mismatch would otherwise be stale images with no signal anywhere.
        if (!res.ok) {
          return logToAxiom({
            type: 'warning',
            name: 'image-cacher-invalidate',
            message: 'image-cacher invalidate returned a non-success status',
            imageKey: url,
            scope,
            status: res.status,
          }).catch(() => {
            // swallow — best effort logging
          });
        }
      })
      .catch((err) => {
        logToAxiom({
          type: 'warning',
          name: 'image-cacher-invalidate',
          message: 'image-cacher invalidate failed',
          imageKey: url,
          scope,
          error: safeError(err),
        }).catch(() => {
          // swallow — best effort logging
        });
      });
  }
}

export async function deleteImageFromS3({ id, url }: { id: number; url: string }) {
  if (!env.DATABASE_IS_PROD) return;
  // Legacy avatar rows hold a full external URL where every other row holds a bucket key.
  // Handing one to deleteObject as a Key can only fail, and it is not ours to delete anyway.
  if (!url || url.startsWith('http')) {
    // Skipping is safe because no row stores a url for a bucket we own — a property of the data,
    // not of this code. A first-party url arriving here means that changed, and the skip would
    // then be dropping a real delete instead of declining someone else's.
    if (/^https?:\/\/[^/]*\bcivitai\.com/i.test(url))
      await logToAxiom({
        type: 'warning',
        name: 'delete-image-from-s3-skipped-first-party-url',
        message: 'Image.url holds a first-party url, not a bucket key; nothing was deleted',
        imageId: id,
        url,
      }).catch(() => undefined);
    return;
  }

  try {
    const otherImagesWithSameUrl = await dbWrite.image.findFirst({
      select: { id: true },
      where: {
        url: url,
        id: { not: id },
      },
    });

    if (!!otherImagesWithSameUrl) return;

    // B2 is the only backend an image can be on, so the registry is consulted for observability
    // rather than to choose a destination — a miss means "unregistered", never "somewhere else".
    // This used to branch to a second backend on a miss, and that branch could not succeed, so
    // every miss left the object behind a row that was already deleted.
    //
    // The `.catch` is belt and braces with the `await` fix inside resolveMediaLocation: no failure
    // of the lookup may stop the delete, and inlining the guard keeps that true even if the
    // resolver later grows a throwing path again.
    //
    // The reason is sanitised INSIDE that `.catch`, under its own try, which is what keeps it total.
    // `safeError` ends in `String(e)` for a non-Error, and that throws on a value with no primitive
    // conversion — `Object.create(null)`, or anything with a throwing `toString`. Calling it in the
    // log payload below instead would put that throw inside the OUTER try, skipping the B2 delete:
    // the exact failure this `.catch` exists to prevent, reintroduced by the code reporting it.
    let resolverError: MixedObject | undefined;
    const location = await resolveMediaLocation(url).catch((error: unknown) => {
      try {
        resolverError = safeError(error);
      } catch {
        resolverError = { message: 'resolver rejected with a value that could not be serialised' };
      }
      return null;
    });
    if (!location) {
      // Not a failure — the delete proceeds against B2 below. But an unregistered image is a
      // registry gap (or a storage-resolver outage), and silently treating it as B2 is exactly
      // what made the gap invisible. Rate of this line is the health signal, so it carries the
      // reason too: routing a rejection here instead of to the catch below would otherwise discard
      // the only record of WHY the resolver failed.
      await logToAxiom({
        type: 'warning',
        name: 'delete-image-from-s3-unresolved-location',
        message: 'storage-resolver returned no location; deleting from B2 anyway',
        imageId: id,
        url,
        ...(resolverError !== undefined && { error: resolverError }),
      }).catch(() => undefined);
    }

    const b2Client = getB2ImageS3Client();
    await withRetries(() =>
      b2Client.send(
        new DeleteObjectCommand({
          Bucket: env.S3_IMAGE_B2_BUCKET ?? 'civitai-media-uploads',
          Key: url,
        })
      )
    );
  } catch (error) {
    // Nothing retries this: deleteImages drops the DB row first, so a lost object stays
    // publicly reachable (CDN urls are unsigned) with only this line to find it by.
    await logToAxiom({
      type: 'error',
      name: 'delete-image-from-s3-failed',
      message: 'S3 delete failed; the object may still be public',
      imageId: id,
      url,
      error: safeError(error),
    }).catch(() => undefined);
  }

  // Outside the try: a failed object delete is exactly when invalidation matters, because the
  // bytes are still in the bucket and a live cache entry keeps serving content whose row is
  // already gone. The `otherImagesWithSameUrl` return above still skips this — that url belongs
  // to an image that is still live.
  await purgeResizeCache({ url: url });
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

/**
 * Associates already-fetched tags to their images in O(N + M).
 *
 * `getImageTagsForImages` returns the tags for EVERY image in the batch, so a
 * per-image `tags.filter(x => x.imageId === i.id)` rescans the whole array once
 * per image — O(N x M), and M grows with N. CPU profiles of the production API
 * showed that construct dominating multi-second event-loop stalls.
 *
 * 🔴 The empty case must stay `[]`, NOT `undefined`. `.filter()` returned `[]`
 * for an image with no tags and `Map.get()` returns `undefined`; those are
 * different values in the API response, and images with no tags are common.
 * That is what the `?? []` is for — do not "simplify" it away.
 */
export function attachTagsToImages<TImage extends { id: number }, TTag extends { imageId: number }>(
  images: TImage[],
  tags: TTag[] | undefined
): (TImage & { tags: TTag[] })[] {
  const tagsByImageId = tags?.reduce((acc, tag) => {
    const arr = acc.get(tag.imageId);
    if (arr) arr.push(tag);
    else acc.set(tag.imageId, [tag]);
    return acc;
  }, new Map<number, TTag[]>());

  return images.map((i) => ({ ...i, tags: tagsByImageId?.get(i.id) ?? [] }));
}

export const deleteImageById = async ({
  id,
  updatePost,
}: GetByIdInput & { updatePost?: boolean }) => {
  updatePost ??= true;
  try {
    // Resolved BEFORE the delete: `CollectionItem.imageId` is `onDelete: Cascade`, so
    // once the row is gone there is no way left to learn which collections were
    // showing this image. Their documents denormalize it and the collections index
    // only sweeps newly created collections, so without this they keep rendering a
    // thumbnail for an image that no longer exists. The resolver is non-throwing, so
    // a failure here costs the reindex rather than cancelling the delete.
    const collectionsToRebuild = await getCollectionIdsForImages({
      imageIds: [id],
      source: 'image-delete',
    });

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
      imageMetaCache.refresh(id),
      imageMetadataCache.refresh(id),
      enqueueCollectionRebuild({ ...collectionsToRebuild, source: 'image-delete' }),
    ]);

    return image;
  } catch (error) {
    // The row may already be gone from the DB while cleanup (search-index delete,
    // cache busts, S3) failed — swallowing that silently leaves the image visible
    // in search/feeds forever, which then 500s anything that FKs to it (reports).
    await logToAxiom({
      type: 'error',
      name: 'delete-image-cleanup-failed',
      message: 'deleteImageById failed; image may remain indexed',
      imageId: id,
      error: safeError(error),
    }).catch(() => undefined);
  }
};

/**
 * Queue an image that has been REPLACED (not deleted) for destruction later, instead of
 * destroying it inline.
 *
 * A replacement is not a deletion: nobody asked for the old picture to stop existing, they
 * asked for a new one to start being used. Destroying the old row + stored object at that
 * moment turns every reference still holding its url into a 404 — and several such caches
 * are legitimate and long-lived (the image CDN's redirect is `max-age=86400`, the
 * account-switcher roster in localStorage is durable by design, feeds and embeds hold
 * rendered urls). A stale-but-present avatar is invisible to a user; a deleted one is a
 * broken image. Deferring the reap makes the whole class self-correcting rather than
 * permanently broken until every cache is individually fixed.
 *
 * The queue row is the clock: `remove-replaced-images` measures the retention window from
 * its `createdAt`, exactly as `remove-blocked-images` does for `BlockedImageDelete`.
 *
 * `DO UPDATE` rather than `DO NOTHING` (which is what `enqueueJobs` uses) is load-bearing.
 * A user can re-select a previously-replaced image, so the same id can be queued twice; on
 * conflict the row must RESTART its window, not inherit the first replacement's clock, or
 * the second replacement gets no retention at all.
 *
 * Errors are swallowed and logged, like `deleteImageById` above. The one caller runs inside
 * the `Promise.all` that decides whether a profile save reports success, and a save that has
 * already committed must not surface as "error updating your profile" because a cleanup
 * enqueue failed. The failure direction is also the safe one: the image stays fetchable and
 * is not reaped, so the worst case is one leaked object with a log line naming it — never a
 * broken avatar.
 */
export async function queueReplacedImageDeletion(ids: number[]) {
  // Deduped and chunked like `enqueueJobs`, whose statement shape this otherwise copies. The
  // dedupe is not hygiene: `DO UPDATE` cannot touch the same row twice in one statement, so a
  // repeated id in a single call would fail the whole insert.
  const batches = chunk(uniq(ids), 500);
  for (const batch of batches) {
    try {
      await dbWrite.$executeRaw`
        INSERT INTO "JobQueue" ("entityId", "entityType", "type")
        VALUES ${Prisma.join(
          batch.map(
            (entityId) =>
              Prisma.sql`(${entityId}::integer, ${EntityType.Image}::"EntityType", ${JobQueueType.ReplacedImageDelete}::"JobQueueType")`
          )
        )}
        ON CONFLICT ("entityType", "entityId", "type")
        DO UPDATE SET "createdAt" = NOW()
      `;
    } catch (error) {
      await logToAxiom({
        type: 'error',
        name: 'queue-replaced-image-deletion-failed',
        message: 'replaced image was not queued for deletion; it will not be reaped',
        imageIds: batch,
        error: safeError(error),
      }).catch(() => undefined);
    }
  }
}

export async function deleteImages(ids: number[], updatePosts = true) {
  const images = await Limiter({ batchSize: 100 }).process(ids, async (ids, batchIndex) => {
    // Resolved before the DELETE for the same reason as deleteImageById: the
    // membership rows cascade away with the images, taking with them the only record
    // of which collection documents now hold a dead thumbnail.
    const collectionsToRebuild = await getCollectionIdsForImages({
      imageIds: ids,
      source: 'image-delete-bulk',
    });

    const results = await dbWrite.$queryRaw<
      { id: number; url: string; postId: number | null; nsfwLevel: number; userId: number }[]
    >`
      DELETE FROM "Image"
      WHERE id IN (${Prisma.join(ids)})
      RETURNING id, url, "postId", "nsfwLevel", "userId"
    `;
    const imageIds = results.map((x) => x.id);
    const idsForPostUpdate = updatePosts ? results.map((x) => x.postId).filter(isDefined) : [];

    const invalidateExistence = invalidateManyImageExistence(imageIds);

    await Promise.all([
      queueImageSearchIndexUpdate({
        ids: imageIds,
        action: SearchIndexUpdateQueueAction.Delete,
      }),
      updatePostNsfwLevel(idsForPostUpdate),
      bustCachesForPosts(idsForPostUpdate),
      postMetrics.queueUpdate(idsForPostUpdate),
      invalidateExistence,
      imageMetaCache.refresh(imageIds),
      imageMetadataCache.refresh(imageIds),
      enqueueCollectionRebuild({ ...collectionsToRebuild, source: 'image-delete-bulk' }),
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

/** Mark remix-source images as mod-reviewed so the audit job won't re-flag them. */
async function markRemixSourceReviewed(images: { id: number; needsReview: string | null }[]) {
  const remixSourceIds = images
    .filter((img) => img.needsReview === 'remixSource')
    .map((img) => img.id);
  if (remixSourceIds.length === 0) return;

  await dbWrite.$executeRaw`
    UPDATE "Image"
    SET "metadata" = "metadata" || '{"remixSourceReviewed": true}'::jsonb
    WHERE id IN (${Prisma.join(remixSourceIds)})
  `;
}

export async function handleUnblockImages({
  ids: imageIds,
  moderatorId,
  removeMinorFlag,
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
                ? removeMinorFlag
                  ? Prisma.sql`"minor" = FALSE,`
                  : Prisma.sql`"minor" = CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE END,`
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

    const postIds = uniq(images.map(({ postId }) => postId).filter(isDefined));
    await Promise.all([
      resetBlockedNsfwLevel(ids),
      dropBlockedImageDeleteQueue(ids),
      queueImageSearchIndexUpdate({ ids, action: SearchIndexUpdateQueueAction.Update }),
      deleteImagTagsForReviewByImageIds(ids),
      bulkRemoveBlockedImages(images.map(({ pHash }) => pHash).filter(isDefined)),
      // Comic projects are gated on `Image.needsReview`/`ingestion`/
      // `tosViolation`. Unblock flips those, but `processImageScanWorkflow`
      // (where the standard re-queue lives) isn't on this code path —
      // re-queue here so the search index re-evaluates visibility.
      queueComicsForPanelImages(ids),
    ]);
    // Bust after the writes above land so a concurrent reader can't refill the cache from pre-update rows.
    if (postIds.length) await bustCachesForPosts(postIds);

    if (moderatorId) {
      await trackModActivity(moderatorId, {
        entityType: 'image',
        entityId: ids,
        activity: 'review',
      });
    }
  });

  // Resolve any pending appeals for images that were in appeal review
  const appealImageIds = images.filter((img) => img.needsReview === 'appeal').map((img) => img.id);

  if (appealImageIds.length > 0) {
    await resolveEntityAppeal({
      ids: appealImageIds,
      entityType: EntityType.Image,
      status: AppealStatus.Approved,
      userId: moderatorId,
    });
  }

  // Prevent remix-source audit job from re-flagging accepted images
  await markRemixSourceReviewed(images);

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
    const postIds = uniq(images.map(({ postId }) => postId).filter(isDefined));
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
      // Same reason as `handleUnblockImages` — moderator block bypasses
      // `processImageScanWorkflow`, so we queue the parent comic project
      // here directly. Without this the comic stays indexed under its
      // pre-block (visible) state.
      queueComicsForPanelImages(ids),
    ]);
    // Bust after the block write commits so a concurrent reader can't refill with the pre-block state.
    if (postIds.length) await bustCachesForPosts(postIds);
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

  // Prevent remix-source audit job from re-flagging blocked images
  await markRemixSourceReviewed(images);

  return images;
}

// NOTE: the moderator `image.moderate` verdict (block/unblock from the review queue + inline badges) now
// lives in the moderator spoke app (apps/moderator); the main app delegates via callModAction. The
// handleBlockImages/handleUnblockImages primitives below remain only for the not-yet-migrated consumers
// that call them directly (the Knights-of-New-Order game, the /api/mod/{remove,restore}-images automation
// endpoints). Their `include: ['phash-block' | 'user-notification']` branches are dead until those callers
// migrate — do not add new callers.

export async function updateNsfwLevel(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  ids = [...new Set(ids)]; // dedupe
  if (!ids.length) return;
  await dbWrite.$executeRawUnsafe(
    `SELECT update_nsfw_levels_new(ARRAY[${ids.join(',')}]::integer[])`
  );
  await thumbnailCache.refresh(ids);
}

// Single source of truth for restoring an image's rating after it's unblocked.
// Blocking force-sets nsfwLevel=Blocked and may leave the rating lock on; the recompute
// (update_nsfw_levels_new) skips locked rows, so a Blocked-locked row can never be restored
// by updateNsfwLevel alone. Reset+unlock only the Blocked rows (never-corrupted locks are
// preserved), then recompute — untagged rows fall to Unrated and re-derive on rescan.
// Used by both unblock paths (handleUnblockImages and report.service resolveEntityAppeal).
export async function resetBlockedNsfwLevel(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  ids = [...new Set(ids)];
  if (!ids.length) return;
  await dbWrite.$executeRaw`
    UPDATE "Image"
    SET "nsfwLevel" = 0, "nsfwLevelLocked" = FALSE
    WHERE id IN (${Prisma.join(ids)}) AND "nsfwLevel" = ${NsfwLevel.Blocked};
  `;
  await updateNsfwLevel(ids);
}

/**
 * Clears a pending blocked-image purge. `create_job_queue_record` is ON CONFLICT DO NOTHING and
 * `remove-blocked-images` counts its retention window from the queue row's `createdAt`, so a row
 * left behind by an unblock makes a later re-block inherit the *original* block's clock — the
 * image can then be deleted with no retention at all. Call this from anything that takes an image
 * out of `Blocked` or clears its `blockedFor`.
 */
export async function dropBlockedImageDeleteQueue(ids: number[]) {
  if (!ids.length) return;
  // ANY over an array rather than IN over a join: callers pass unbounded id lists, and one
  // bind parameter can't hit Postgres' 65535 parameter ceiling.
  await dbWrite.$executeRaw`
    DELETE FROM "JobQueue"
    WHERE type = ${JobQueueType.BlockedImageDelete}::"JobQueueType"
      AND "entityType" = ${EntityType.Image}::"EntityType"
      AND "entityId" = ANY(${ids})
  `;
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

/**
 * Runtime toggle for the new image ingestion path (createImageIngestionRequest
 * with the expanded mediaRating step). Reads from Redis so ops can flip
 * without a deploy. Accepts '1'/'true' / '0'/'false' as string values.
 *
 * If the key doesn't exist (first request after deploy), seeds it to 'false'
 * so the toggle is discoverable in Redis and explicitly off by default.
 * Operators set the key to '1' to enable.
 */
async function isImageScannerNewEnabled(): Promise<boolean> {
  // The HA/Sentinel sysRedis returns a Buffer for BLOB_STRING replies, which
  // matched none of the literals pre-fix → fell through and destructively
  // overwrote the operator's '1' with 'false'. parseScannerFlag coerces the
  // Buffer first and returns null ONLY for a genuinely-unset/unknown key, so
  // the seed below now fires only in its intended default-seeding case.
  // See PR #2697/#2700 for the canonical Buffer-vs-string regression.
  const raw = await sysRedis.get(REDIS_SYS_KEYS.SYSTEM.IMAGE_SCANNER_NEW);
  const parsed = parseScannerFlag(raw);
  if (parsed !== null) return parsed;
  await sysRedis.set(REDIS_SYS_KEYS.SYSTEM.IMAGE_SCANNER_NEW, 'false');
  return false;
}

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

function extractSubmitErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') {
    const { errors, title } = error as { errors?: { messages?: unknown }; title?: unknown };
    const messages = errors?.messages;
    if (Array.isArray(messages) && messages.length) return messages.join('; ');
    if (typeof title === 'string') return title;
  }
  return null;
}

// Permanent terminalizes on the first attempt, so only codes that describe this input
// belong here. A systemic code (401/403/404, or 413 when our own body is the thing that
// grew) would terminalize every image submitted during the outage.
const PERMANENT_SUBMIT_STATUSES = [400, 415, 422];

async function markImageScanSubmitFailure({
  dbClient,
  imageId,
  status,
  error,
}: {
  dbClient: { $executeRaw: typeof dbWrite.$executeRaw };
  imageId: number;
  status?: number;
  error: unknown;
}) {
  const reason = extractSubmitErrorMessage(error);
  const failureClass =
    !!status && PERMANENT_SUBMIT_STATUSES.includes(status)
      ? ImageScanFailureClass.Permanent
      : classifyImageScanFailure({ reason, failureType: 'send-fail' });
  const isPermanent = failureClass === ImageScanFailureClass.Permanent;

  const errorJson = JSON.stringify({
    failureType: 'send-fail',
    responseStatus: status,
    reason: reason ?? undefined,
    failureClass,
    at: new Date().toISOString(),
  });

  await dbClient.$executeRaw`
    UPDATE "Image"
    SET
      -- Transient keeps its status; Error would demote a fresh upload to the hourly lane.
      "ingestion" = CASE
        WHEN ${isPermanent}::boolean THEN ${ImageIngestionStatus.Error}::"ImageIngestionStatus"
        ELSE "ingestion"
      END,
      "scanRequestedAt" = ${new Date()},
      "scanJobs" = jsonb_set(
        jsonb_set(
          COALESCE("scanJobs", '{}'),
          '{retryCount}',
          to_jsonb(COALESCE(("scanJobs"->>'retryCount')::int, 0) + 1)
        ),
        '{error}',
        ${errorJson}::jsonb
      )
    WHERE id = ${imageId}
      -- Submit retries can outlive the callback, so a late failure must not clobber a verdict.
      AND "ingestion" = ANY(ARRAY['Pending','Rescan','Error']::"ImageIngestionStatus"[])
  `;

  return failureClass;
}

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

  // if (!isProd || !env.IMAGE_SCANNING_ENDPOINT) {
  //   console.log('skipping image ingestion');
  //   const updated = await dbClient.image.update({
  //     where: { id: image.id },
  //     select: { postId: true },
  //     data: {
  //       scanRequestedAt,
  //       scannedAt: scanRequestedAt,
  //       ingestion: ImageIngestionStatus.Scanned,
  //       nsfwLevel: NsfwLevel.PG,
  //     },
  //   });

  //   // Update post NSFW level
  //   if (updated.postId) await updatePostNsfwLevel(updated.postId);

  //   return true;
  // }

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

  if (await isImageScannerNewEnabled()) {
    const {
      data: workflowResponse,
      error: submitError,
      status: submitStatus,
    } = await createImageIngestionRequest({
      imageId: id,
      url,
      type,
      callbackUrl,
      priority: lowPriority ? 'low' : undefined,
    });
    if (!workflowResponse) {
      imageScanSubmittedCounter.inc({ lane: 'new', result: 'failed' });
      const failureClass = await markImageScanSubmitFailure({
        dbClient,
        imageId: id,
        status: submitStatus,
        error: submitError,
      });
      // The orchestrator submit already logs the transient failure in
      // createImageIngestionRequest, but from here it's otherwise a silent
      // `return false` — surface it at the dispatch layer so the failure is
      // attributable to a specific image + media type.
      logToAxiom({
        name: 'image-ingestion',
        type: 'error',
        reason: 'no-workflow-response',
        failureType: 'send-fail',
        failureClass,
        responseStatus: submitStatus,
        imageId: id,
        mediaType: type,
      }).catch(() => null);
      return false;
    }
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
    imageScanSubmittedCounter.inc({ lane: 'new', result: 'success' });
    return true;
  }

  let scanUrl = `${env.IMAGE_SCANNING_ENDPOINT}/enqueue`;
  if (lowPriority) scanUrl += '?lowpri=true';

  const response = await fetch(scanUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: fetchTimeoutSignal(60_000),
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

    imageScanSubmittedCounter.inc({ lane: 'legacy', result: 'success' });
    return true;
  } else {
    await logToAxiom({
      name: 'image-ingestion',
      type: 'error',
      imageId: id,
      url,
      responseStatus: response.status,
    });

    imageScanSubmittedCounter.inc({ lane: 'legacy', result: 'failed' });
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

  // TODO.articleImageScan: uncomment when ready to enable image scanning for articles
  // if (!isProd || !callbackUrl) {
  //   console.log('skip ingest');
  //   await dbClient.image.updateMany({
  //     where: { id: { in: imageIds } },
  //     data: {
  //       scanRequestedAt,
  //       scannedAt: scanRequestedAt,
  //       ingestion: ImageIngestionStatus.Scanned,
  //       nsfwLevel: NsfwLevel.PG,
  //     },
  //   });
  //   return true;
  // }

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
      signal: fetchTimeoutSignal(60_000),
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

export function enqueueImageIngestion({
  images,
  name,
  userId,
  lowPriority,
}: {
  images: IngestImageInput[];
  name: string;
  userId?: number;
  lowPriority?: boolean;
}) {
  if (!images.length) return;

  logToAxiom({
    name: `${name}:enqueue`,
    type: 'info',
    userId,
    message: `Enqueuing ${images.length} images for ingestion`,
    imageIds: images.map((img) => img.id),
  }).catch(() => undefined);

  const tasks = images.map(
    (img) => () =>
      ingestImage({ image: img, lowPriority, userId }).catch((error) => {
        logToAxiom({
          name,
          type: 'error',
          userId,
          imageId: img.id,
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      })
  );

  limitConcurrency(tasks, 5).catch(() => undefined);
}

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
  // RAW Post.model3dId — visibility-checked into a nullable output field below
  // (the batched `getVisibleModel3DIds` gate) before reaching the client. Drives
  // the "Posted to 3D Model" chip on the feed-modal path without an ambient
  // `model3d.getByPostId` lookup.
  model3dId: number | null;
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
  collectionItemNote?: string | null;
  collectionItemStatus?: CollectionItemStatus | null;
  collectionItemAddedById?: number | null;
};

type GetAllImagesInput = GetInfiniteImagesOutput & {
  useCombinedNsfwLevel?: boolean;
  user?: SessionUser;
  // Request color, used to pick which "new & upcoming" board backs `newCreators`.
  domain?: DomainColor;
  headers?: Record<string, string>; // TODO needed?
  dbTarget?: 'read' | 'write' | 'datapacket';
  signal?: AbortSignal;
  // Caller identity forwarded to Meili via X-Search-Actor for abuse/rate
  // correlation. Built upstream via buildSearchActor().
  actor?: string;
};
// Derived from `getAllImages`' return type, which applies `stripImageForInfiniteWire`
// to each item — so this shape is already narrowed to
// `Omit<..., IMAGE_INFINITE_DROPPED_FIELDS>`. Any consumer that reads a dropped field
// (client component or internal server caller) is a compile error. See
// `~/server/utils/image-infinite-wire.ts`.
export type ImagesInfiniteModel = AsyncReturnType<typeof getAllImages>['items'][0];

// Per-call ceiling for the image-feed raw query. The `civitai` postgres role
// has statement_timeout=0 (overriding the cluster's 300s), so a single slow
// run of this query (mean 4.2s / max 115.8s, dominant source of replica
// statement-timeout cancellations) can monopolize the replica's parallel-worker
// budget, back up pgbouncer-ro, and cascade into api-primary health-check
// failures. 20s is comfortably above p99 for healthy runs while bounding
// pathological cases. On timeout the caller returns an empty page (graceful)
// rather than surfacing a 500, with a structured axiom log for observability.
const IMAGE_FEED_STATEMENT_TIMEOUT_MS = 20_000;

// Increments when the image-feed query is server-side cancelled by the
// statement_timeout ceiling above. Labelled by dbTarget so we can see
// which pool the slow query landed on. Distinguished from pg_cancel_backend
// or client AbortSignal cancellations by checking the error message — those
// also use SQLSTATE 57014 but should propagate rather than fall back to empty.
const imageFeedStatementTimeoutCounter = registerCounterWithLabels({
  name: 'image_feed_statement_timeout_total',
  help: 'getAllImages raw query cancelled by server-side statement_timeout',
  labelNames: ['dbTarget'] as const,
});

// getImageMetricsObject soft-fallback rate: incremented whenever the ClickHouse
// image-metrics read exceeds CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS and we serve
// empty (TRANSIENT-zero) metrics. Makes the otherwise axiom-only fallback rate
// observable in Prometheus. No label dimension — the timeout has no natural one.
const imageMetricsClickhouseTimeoutCounter = registerCounter({
  name: 'image_metrics_clickhouse_timeout_total',
  help: 'getImageMetricsObject ClickHouse read exceeded the soft-fallback timeout (served empty metrics)',
});

/**
 * Who may ask for unpublished content, and over whose work.
 *
 * A moderator may ask about anyone. Everyone else may ask only about themselves,
 * and only when the request is ALREADY scoped to them — the scoping is the
 * authorization, not a separate check that could drift from it. An unscoped
 * `notPublished` from a non-moderator would otherwise return every draft on the
 * site, so a missing `targetUserId` must refuse rather than default.
 *
 * `targetUserId` is the creator being browsed, NOT the viewer. Those are
 * different fields on every path here (`getAllImages` calls the viewer `userId`
 * and the creator `targetUserId`; the search builders call the creator `userId`
 * and the viewer `currentUserId`), and passing the wrong one turns this into a
 * check that always passes.
 */
function canRequestUnpublished({
  isModerator,
  currentUserId,
  targetUserId,
}: {
  isModerator?: boolean;
  currentUserId?: number | null;
  targetUserId?: number | null;
}) {
  if (isModerator) return true;
  return !!currentUserId && !!targetUserId && targetUserId === currentUserId;
}

/**
 * Resolve the `hideChallenges` flag into an `excludedTagIds` entry, in place.
 * Mirrors `enforceBlockedBrowsingTags`: the client sends intent, the server owns
 * the tag id, and every query path picks it up from `excludedTagIds` unchanged.
 * Reads the static config rather than `getChallengeConfig()` so the feed doesn't
 * take a sysRedis round-trip per request.
 */
function applyHideChallengesExclusion(input: {
  hideChallenges?: boolean;
  excludedTagIds?: number[];
}) {
  if (!input.hideChallenges) return;
  input.excludedTagIds = [
    ...new Set([...(input.excludedTagIds ?? []), dailyChallengeConfig.challengeTagId]),
  ];
}

export const getAllImages = async (
  input: GetAllImagesInput & {
    userId?: number;
  }
) => {
  // Fail loud rather than serve unfiltered. This path has no way to express a
  // hub — collection membership lives on the search index, not in a column here —
  // so a hubId arriving means the dispatcher routed wrongly. Returning results
  // would hand the caller the global feed labelled as their hub.
  if (input.hubId)
    throw throwInternalServerError(
      new Error('getAllImages cannot serve a hub; hub queries must use the index path')
    );

  // Ahead of every early empty return below: the point of throwing rather than falling back is
  // that the misuse is legible, and an empty page from one of those branches hides it.
  if (input.sort === ImageSort.RecentlyAdded && !input.collectionId) {
    throw throwBadRequestError('Recently Added sort requires a collectionId');
  }

  const blockedEnforcement = await enforceBlockedBrowsingTags(input, {
    id: input.user?.id,
    username: input.user?.username,
    isModerator: input.user?.isModerator,
  });
  if (blockedEnforcement.emptyResult) return { nextCursor: undefined, items: [] };
  applyHideChallengesExclusion(input);

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
    model3dId,
    imageId, // used in public API
    username,
    period,
    periodMode,
    tags,
    generation,
    reviewId,
    newCreators,
    domain,
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
    publishedOnly,
    notPublished,
    scheduled,
    tools,
    techniques,
    baseModels,
    collectionTagId,
    excludedUserIds,
    excludedTagIds,
    disablePoi,
    disableMinor,
    poiOnly,
    minorOnly,
    pendingReviewOnly,
  } = input;
  let { browsingLevel, userId: targetUserId, ids } = input;
  let { dbTarget = 'read' } = input;

  // While the DataPacket replica is missing ImageResourceNew backfill, force
  // queries that join ImageResourceNew (modelId/modelVersionId/reviewId filter
  // or baseModels filter) to the writer. Flipt flag lets us flip off post-backfill.
  const joinsImageResourceNew = !!modelId || !!modelVersionId || !!reviewId || !!baseModels?.length;
  if (
    joinsImageResourceNew &&
    dbTarget !== 'write' &&
    (await isFlipt(FLIPT_FEATURE_FLAGS.IMAGE_RESOURCE_USE_WRITE))
  ) {
    dbTarget = 'write';
  }

  const imageDb =
    dbTarget === 'write' ? pgDbWrite : dbTarget === 'datapacket' ? datapacketDbRead : pgDbRead;
  const AND: Prisma.Sql[] = [Prisma.sql`i."postId" IS NOT NULL`];
  const WITH: Prisma.Sql[] = [];
  let orderBy: string;
  const cacheTags: string[] = [];
  // Default-deny: cache only enabled for safe, shareable paths (set explicitly below).
  // Personalized branches set isPersonalized = true. Final cacheTime is forced to 0
  // at the cache-wrapper site if isPersonalized — this makes the invariant
  // ordering-independent so a personalization branch above the modelId/modelVersionId
  // enable site (e.g. `hidden`) can't be silently re-enabled by a later branch.
  let cacheTime = 0;
  let isPersonalized = false;
  const userId = user?.id;
  const isModerator = user?.isModerator ?? false;
  // Moderators opting into the "pending review" collection filter get the same
  // unscanned-content visibility as the existing `pending` flag (nsfwLevel = 0 allowed).
  const effectivePending = pending || (isModerator && !!pendingReviewOnly);
  const includeCosmetics = include?.includes('cosmetics'); // TODO: This must be done similar to user cosmetics.

  // Exclude unselectable browsing levels
  browsingLevel = onlySelectableLevels(browsingLevel);

  // `applyDomainFeature` only backfills an absent `browsingLevel` on capped
  // (green) domains, so on red/blue it can arrive undefined and reach the SQL as
  // NULL — `(nsfwLevel & NULL)` is NULL, silently dropping every row. Fail closed
  // to public rather than to nothing; widening here would serve levels the caller
  // never asked for.
  if (!browsingLevel) browsingLevel = publicBrowsingLevelsFlag;

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
    prefetchedNewCreators,
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
      ? dbRead.user
          .findUnique({ where: { username }, select: { id: true } })
          .then((u) => u ?? dbWrite.user.findUnique({ where: { username }, select: { id: true } }))
      : undefined,
    prioritizedUserIds?.length
      ? isFlipt('use-model-version-cache-for-images', modelVersionId?.toString(), {
          isModerator: isModerator.toString(),
          userId: userId?.toString() || 'anon',
        })
      : false,
    userId && followed ? getUserFollows(userId) : undefined,
    newCreators ? getNewCreatorUserIds({ entity: 'images', domain }) : undefined,
    collectionId
      ? getUserCollectionPermissionsById({ userId, isModerator, id: collectionId })
      : undefined,
    needsCollectionSeed ? getCollectionRandomSeed() : undefined,
  ]);

  if (hidden) {
    if (!userId) throw throwAuthorizationError();
    const imageIds = prefetchedHiddenImages?.map((x) => x.imageId) ?? [];
    if (imageIds.length) {
      isPersonalized = true; // per-user hidden image set
      AND.push(Prisma.sql`i."id" IN (${Prisma.join(imageIds)})`);
    } else {
      return { items: [], nextCursor: undefined };
    }
  }

  if (username && !targetUserId) {
    if (!prefetchedTargetUser) throw throwNotFoundError('User not found');
    targetUserId = prefetchedTargetUser.id;
  }

  // Hacked this to use the model version image cache instead
  const prioritizeUser = !!prioritizedUserIds?.length;
  const useModelVersionCache = prioritizeUser && prefetchedIsFlipt;
  if (prioritizeUser && useModelVersionCache) {
    if (cursor) throw throwBadRequestError('Cannot use cursor with prioritizedUserIds');
    if (!modelVersionId)
      throw throwBadRequestError('modelVersionId is required when using prioritizedUserIds');

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
  if (notPublished && canRequestUnpublished({ isModerator, currentUserId: userId, targetUserId })) {
    AND.push(Prisma.sql`(p."publishedAt" IS NULL)`);
  } else if (!effectivePending) {
    // Strict published-only, with the owner carve-out gated on the `scheduled`
    // opt-in — the same rule the two Meili builders apply
    // FOR A NON-MODERATOR.
    //
    // Deliberately not claiming full parity, because there isn't any. A
    // moderator's `scheduled` request diverges: Meili emits `publishedAtUnix >
    // now` (scheduled content from every creator), while this path emits the
    // ordinary published feed plus that one moderator's own scheduled posts. So
    // a moderator on a collection or any other DB-pinned view sees a different
    // population than they would on the index. Pre-existing and out of scope
    // here; recorded so the next person checking parity does not read a
    // three-backend claim and stop looking.
    //
    // A fourth site is out of step too: `getImage` (~:6452) still carries the old
    // permissive `OR p."userId" = <viewer>` with no publish predicate.
    //
    // The carve-out used to be a bare `p."userId" = <viewer>` with no publish
    // predicate and no opt-in, so every signed-in caller got their own drafts,
    // bounty entry uploads and orphans mixed into EVERY feed whether or not they
    // asked. `p."publishedAt" > now()` is what makes it mean scheduled rather
    // than unpublished; drafts have a NULL publish time and are reached through
    // the Draft toggle instead (`notPublished`, handled above).
    //
    // Cache keying is NOT carried by this clause — measured, because the obvious
    // reading is that removing the bare owner match widened the key. It does not:
    // the availability carve-out a few lines below binds `userId` into the SQL
    // for every non-moderator, and `queryCacheRaw` hashes the whole statement
    // including its values. So the key stays per-user for the same viewers it
    // always was. A moderator's key does widen — they skip the availability
    // clause too — which shares one key across moderators rather than one each,
    // and cannot collide with a non-moderator's differently-shaped SQL.
    if (userId && !publishedOnly && scheduled) {
      AND.push(
        Prisma.sql`(p."publishedAt" < now() OR (p."userId" = ${userId} AND p."publishedAt" > now()))`
      );
    } else {
      AND.push(Prisma.sql`(p."publishedAt" < now())`);
    }
  }

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
  if (excludedTagIds?.length) {
    const notExcluded = Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TagsOnImageDetails" toi
      WHERE toi."imageId" = i.id
        AND toi."tagId" IN (${Prisma.join([...new Set(excludedTagIds)])})
        AND toi."disabled" = FALSE
    )`;
    AND.push(userId ? Prisma.sql`(${notExcluded} OR i."userId" = ${userId})` : notExcluded);
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
      // reviewId joins ResourceReview — out of scope for this PR's cache enable.
    } else if (modelVersionId) {
      AND.push(Prisma.sql`irr."modelVersionId" = ${modelVersionId}`);
      // 10 min — model galleries can tolerate brief staleness; bust hooks in
      // post.service.ts fire on image upload/update for the matching tag.
      cacheTime = CacheTTL.md;
      cacheTags.push(`images-modelVersion:${modelVersionId}`);
    } else if (modelId) {
      joins.push(`JOIN "ModelVersion" mv ON mv.id = irr."modelVersionId"`);
      AND.push(Prisma.sql`mv."modelId" = ${modelId}`);
      cacheTime = CacheTTL.md;
      cacheTags.push(`images-model:${modelId}`);
    }
  }

  // Model3D gallery: posts link to a Model3D via Post.model3dId (no
  // ModelVersion / ImageResourceNew chain involved), so this is just a
  // direct filter on the always-present Post join below. Mirrors the
  // collection / model gallery cache shape — Model3D image uploads are
  // captured by the same post.service bust hooks.
  if (model3dId) {
    AND.push(Prisma.sql`p."model3dId" = ${model3dId}`);
    cacheTime = CacheTTL.md;
    cacheTags.push(`images-model3d:${model3dId}`);
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
    // user-gallery path: out of scope for this PR; future work could enable
    // cache for targetUserId !== userId via an `images-user:${targetUserId}` tag.
    isPersonalized = true;
  }

  // Filter only followed users
  // [x]
  if (userId && followed && prefetchedUserFollows?.length) {
    isPersonalized = true; // per-user follow set
    AND.push(Prisma.sql`i."userId" IN (${Prisma.join(prefetchedUserFollows)})`);
  }

  // Filter to creators on the "new & upcoming" board. Unlike `followed` this set is
  // global (per domain, not per viewer), so it deliberately does NOT set
  // isPersonalized — the feed stays cacheable, and the id list is part of the query
  // text the cache keys on.
  if (newCreators) {
    // An empty board (never populated, or a failed nightly run) must return nothing
    // rather than silently degrading to the unfiltered global feed.
    AND.push(
      prefetchedNewCreators?.length
        ? Prisma.sql`i."userId" IN (${Prisma.join(prefetchedNewCreators)})`
        : Prisma.sql`1 = 0`
    );
  }

  // Filter to specific tags
  if (tags?.length) {
    isPersonalized = true; // tag combinations are high-cardinality; skip cache for now
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
  if (imageId) {
    isPersonalized = true; // single-image lookups don't benefit from caching
    AND.push(Prisma.sql`i.id = ${imageId}`);
  }

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

    // Moderators can opt into viewing ALL entries still under review for a collection
    // (owner-only clause intentionally dropped — mods see every REVIEW item, not just
    // their own). Everyone else: accepted items + the requester's own non-rejected items.
    const collectionStatusFilter =
      isModerator && pendingReviewOnly
        ? `ci."status" = 'REVIEW'`
        : `(ci."status" = 'ACCEPTED'${displayOwnedItems})`;

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
          SELECT "imageId", note, status, "addedById", "collectionItemId", "sortKey"
          FROM (
            SELECT
              ci."imageId",
              ci.note,
              ci.status,
              ci."addedById",
              ci.id as "collectionItemId",
              abs(mod(hashtext(concat(ci.id::text, '${Prisma.raw(
                seedStr
              )}')), 1000000000)) as "sortKey"
            FROM "CollectionItem" ci
            WHERE ci."collectionId" = ${collectionId}
              ${Prisma.raw(collectionTagId ? ` AND ci."tagId" = ${collectionTagId}` : ``)}
              AND ci."imageId" IS NOT NULL
              AND ${Prisma.raw(collectionStatusFilter)}
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
    AND.push(Prisma.sql`i."userId" != ALL(${excludedUserIds}::int[])`);
  }

  const isGallery = modelId || modelVersionId || model3dId || reviewId || userId;
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
    if (sort === ImageSort.Random) {
      isPersonalized = true; // random ordering should not be pinned by a cache
      orderBy = 'ct."sortKey" DESC, i."id" DESC';
    } else if (sort === ImageSort.RecentlyAdded) {
      orderBy = 'ct."collectionItemId" DESC';
    }
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
    if (cursor) throw throwBadRequestError('Cannot use cursor with prioritizedUserIds');
    isPersonalized = true; // prioritizedUserIds reorders/filters per-caller
    if (modelVersionId) AND.push(Prisma.sql`p."modelVersionId" = ${modelVersionId}`);

    // If system user, show community images
    const prioritizseIsSystemUser = prioritizedUserIds.length === 1 && prioritizedUserIds[0] === -1;

    // Confirm system user has posts:
    // Existence check only — `select: { id }` keeps this from decoding the
    // whole Post row (three DateTimes plus the `metadata` Json) to answer a
    // boolean.
    const hasSystemPosts =
      prioritizseIsSystemUser && modelVersionId
        ? await dbRead.post.findFirst({
            where: { userId: -1, modelVersionId },
            select: { id: true },
          })
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
    isPersonalized = true; // per-user reaction filter
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

  if (effectivePending && (isModerator || userId)) {
    isPersonalized = true; // pending view is moderator/owner-scoped
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
      ${imageOnSiteSql()} as "onSite",
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
      p."model3dId",
      p."availability",
      i.minor,
      i.poi,
      i."acceptableMinor",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} "cursorId"
      ${Prisma.raw(
        collectionId
          ? ', ct.note as "collectionItemNote", ct.status as "collectionItemStatus", ct."addedById" as "collectionItemAddedById"'
          : ''
      )}
      ${queryFrom}
      ORDER BY ${Prisma.raw(orderBy)}
      ${Prisma.raw(skip ? `OFFSET ${skip}` : '')}
      LIMIT ${limit + 1}
  `;

  // Final invariant: any personalized branch above forces no-cache, regardless of
  // ordering relative to the modelId/modelVersionId enable site. This prevents a
  // future personalization branch added above the enable from being silently
  // re-cached.
  if (isPersonalized) cacheTime = 0;
  if (!env.IMAGE_QUERY_CACHING) cacheTime = 0;
  // queryCacheRaw wraps imageDb.query so the dual-DB routing (write/datapacket/read)
  // computed above is preserved while gaining Redis cache semantics.
  // bustCacheTag('images-model:X' / 'images-modelVersion:X') is already wired in
  // post.service.ts on image upload/update events.
  const cacheable = queryCacheRaw(
    async <Row>(q: Prisma.Sql) => {
      // Per-call statement_timeout ceiling — see IMAGE_FEED_STATEMENT_TIMEOUT_MS
      // for rationale. The timeout fires server-side (pg error code 57014);
      // we catch it at the call site below and return an empty page.
      const { rows } = await queryWithTimeout(imageDb, IMAGE_FEED_STATEMENT_TIMEOUT_MS, q);
      return rows as Row[];
    },
    'getAllImages',
    // Bumped v1 -> v2 when `p."model3dId"` was added to the SELECT. The query
    // hash already changes with the new column (so old entries fall out of the
    // keyspace on their own), but the explicit version bump abandons the stale
    // keyspace immediately rather than leaving model3dId-less rows resident
    // until their TTL — keeps the feed-modal chip from silently lacking the
    // field on a warm cache after deploy.
    'v2'
  );
  let rawImages: GetAllImagesRaw[];
  try {
    rawImages = await withSpan('image:getAllImages:rawQuery', () =>
      cacheable<GetAllImagesRaw[]>(query, { ttl: cacheTime, tag: cacheTags })
    );
  } catch (e) {
    const code = (e as { code?: string })?.code;
    const message = (e as { message?: string })?.message ?? '';
    // SQLSTATE 57014 (query_canceled) is shared by statement_timeout,
    // pg_cancel_backend(), and client AbortSignal cancellation. Only the
    // first should fall back to an empty page — the others must propagate
    // so callers/observers see the cancellation. Postgres distinguishes
    // them via the error message: "canceling statement due to statement timeout".
    if (code === '57014' && message.includes('statement timeout')) {
      // Query exceeded IMAGE_FEED_STATEMENT_TIMEOUT_MS on the replica.
      // Return an empty page instead of surfacing a 500 — the feed is best-effort
      // and the UI handles `items: []` gracefully. Log to axiom so we can track
      // frequency and identify pathological filter combinations; also bump a
      // counter so we can alert if the rate climbs.
      imageFeedStatementTimeoutCounter.inc({ dbTarget });
      logToAxiom({
        name: 'getInfiniteImages:statement_timeout',
        type: 'warning',
        message: `image feed query exceeded ${IMAGE_FEED_STATEMENT_TIMEOUT_MS}ms ceiling`,
        details: {
          timeoutMs: IMAGE_FEED_STATEMENT_TIMEOUT_MS,
          dbTarget,
          userId,
          limit,
          cursor: cursor ? String(cursor) : undefined,
          sort,
          period,
          modelId,
          modelVersionId,
          collectionId,
          postId,
          username,
          tagCount: tags?.length,
          baseModelCount: baseModels?.length,
        },
      }).catch(() => undefined);
      return { items: [], nextCursor: undefined };
    }
    throw e;
  }
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
  ] = await withSpan('image:getAllImages:parallelFetch', () =>
    Promise.all([
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
    ])
  );

  // Visibility-check the RAW `model3dId`s carried on the feed rows before they
  // reach the client. `p."model3dId"` is unfiltered (it reflects the link, not
  // whether the viewer may SEE the linked Model3D), so a hidden Draft / deleted
  // model's id would otherwise leak as a clickable chip on the feed-modal path.
  // Most feed images aren't linked (model3dId null) so the common page skips the
  // query entirely; the linked few resolve in ONE batched query (no N+1),
  // applying the SAME `canViewModel3d` predicate as the single-post lookup.
  const rawModel3dIds = [
    ...new Set(rawImages.map((i) => i.model3dId).filter((id): id is number => id != null)),
  ];
  const visibleModel3DIds = rawModel3dIds.length
    ? await getVisibleModel3DIds({ model3dIds: rawModel3dIds, userId, isModerator })
    : undefined;

  const images = withSpan('image:getAllImages:transform', () => {
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
      const voteMap = new Map(userVotes.map((v) => [`${v.imageId}:${v.tagId}`, v.vote]));
      for (const tag of tagsVar) {
        const vote = voteMap.get(`${tag.imageId}:${tag.id}`);
        if (vote !== undefined) tag.vote = vote > 0 ? 1 : -1;
      }
    }

    // Pre-index tags by imageId to avoid O(n*m) filter inside map
    const tagsByImageId = tagsVar
      ? tagsVar.reduce((acc, tag) => {
          const arr = acc.get(tag.imageId);
          if (arr) arr.push(tag);
          else acc.set(tag.imageId, [tag]);
          return acc;
        }, new Map<number, typeof tagsVar>())
      : undefined;

    const now = new Date();
    const filtered = rawImages.filter((x) => {
      if (isModerator) return true;
      // if (x.needsReview && x.userId !== userId) return false;
      if ((!x.publishedAt || x.publishedAt > now || !!x.unpublishedAt) && x.userId !== userId)
        return false;
      // if (x.ingestion !== 'Scanned' && x.userId !== userId) return false;
      return true;
    });

    const result: Array<
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
        judgeScore?: JudgeScore | Record<string, number> | null;
        // Visibility-gated linked-Model3D id (or null) for the "Posted to 3D
        // Model" chip on the feed-modal path. See the model3dId override below.
        model3dId?: number | null;
        collectionItemStatus?: CollectionItemStatus | null;
        // Who put the item in the collection — the removal rule accepts them, so the card needs
        // it to offer the action. Only present on a collection-filtered feed.
        collectionItemAddedById?: number | null;
      }
    > = filtered.map(({ userId: creatorId, cursorId, unpublishedAt, collectionItemNote, ...i }) => {
      const judgeScore = parseJudgeScore(collectionItemNote ?? null);
      const match = imageMetrics[i.id];
      const thumbnail = thumbnails[i.id];
      const userData = userBasicData[creatorId];

      return {
        ...i,
        // Override the RAW `p."model3dId"` (spread in via `...i`) with the
        // visibility-gated value: keep the id only when the viewer may see the
        // linked Model3D, else null. Drives the feed-modal chip from a prop —
        // no ambient `model3d.getByPostId`. (`null` here is the three-state
        // "resolved-absent" the chip needs to NOT fall back.)
        model3dId: i.model3dId != null && visibleModel3DIds?.has(i.model3dId) ? i.model3dId : null,
        meta: imageMeta?.[i.id] ?? null,
        nsfwLevel: Math.max(thumbnail?.nsfwLevel ?? 0, i.nsfwLevel),
        // `modelVersionIds` is auto-detected only and `modelVersionIdsManual` is uploader-asserted,
        // matching what the search-index path serves — consumers gate on the difference.
        modelVersionIds:
          imageResources?.[i.id]?.resources
            ?.filter((r) => r.detected)
            .map((r) => r.modelVersionId) ?? [],
        modelVersionIdsManual:
          imageResources?.[i.id]?.resources
            ?.filter((r) => !r.detected)
            .map((r) => r.modelVersionId) ?? [],
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
        tags: tagsByImageId?.get(i.id),
        tagIds: tagIdsVar?.[i.id]?.tags,
        cosmetic: cosmetics?.[i.id] ?? null,
        thumbnailUrl: thumbnail?.url,
        judgeScore,
      };
    });

    // Put into cached order if prioritizing user (model version showcase)
    if (prioritizeUser && useModelVersionCache) {
      result.sort((a, b) => ids!.indexOf(a.id) - ids!.indexOf(b.id));
    }

    return result;
  });

  return {
    nextCursor,
    // Always-on wire trim: drop the grep-proven-unread fields no `image.getInfinite`
    // consumer reads. Narrows `ImagesInfiniteModel` (defined from this return type) to
    // `Omit<..., IMAGE_INFINITE_DROPPED_FIELDS>`, so tsc/`next build` flags any reader.
    // See `~/server/utils/image-infinite-wire.ts` for the traced consumer graph.
    items: images.map(stripImageForInfiniteWire),
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
/**
 * Only this path reports a `source`, so it is added here rather than to the shared
 * alias — `getImagesFromFeedSearch` returns the same alias and never sets one, and
 * widening that would let a caller test it for a value it can never hold. Optional
 * because the blocked-browsing early return and a search reporting none both omit it.
 */
type GetAllImagesIndexSourcedResult = GetAllImagesIndexResult & {
  source?: AsyncReturnType<typeof getImagesFromSearch>['source'];
};
export const getAllImagesIndex = async (
  input: GetAllImagesInput
): Promise<GetAllImagesIndexSourcedResult> => {
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

  const blockedEnforcement = await enforceBlockedBrowsingTags(input, {
    id: user?.id,
    username: user?.username,
    isModerator: user?.isModerator,
  });
  if (blockedEnforcement.emptyResult) return { nextCursor: undefined, items: [] };
  applyHideChallengesExclusion(input);

  // - cursor uses "offset|entryTimestamp" like "500|1724677401898"
  const cursorParsed = input.cursor?.toString().split('|');
  const offset = isNumber(cursorParsed?.[0]) ? Number(cursorParsed?.[0]) : 0;
  const entry = isNumber(cursorParsed?.[1]) ? Number(cursorParsed?.[1]) : undefined;

  const currentUserId = user?.id;

  let searchResults: Awaited<ReturnType<typeof getImagesFromSearch>>['data'];
  let searchNextCursor: Awaited<ReturnType<typeof getImagesFromSearch>>['nextCursor'];
  let searchSource: Awaited<ReturnType<typeof getImagesFromSearch>>['source'];
  try {
    ({
      data: searchResults,
      nextCursor: searchNextCursor,
      source: searchSource,
    } = await withSpan('image:getAllImagesIndex:search', () =>
      getImagesFromSearch({
        ...input,
        currentUserId,
        isModerator: user?.isModerator,
        offset,
        entry,
      })
    ));
  } catch (err) {
    // Meilisearch saturation / timeout on the tRPC hot path (image.getInfinite).
    // Surface as TRPCError SERVICE_UNAVAILABLE (HTTP 503) so the client gets a
    // fast, retryable response instead of bleeding until Traefik's 30s router
    // timeout — which is what backed up the event loop and tipped api-primary
    // into kubelet SIGKILL on 2026-05-29. 503 is the correct code for a
    // transient backend brownout (was TIMEOUT/408 as a tRPC-v10 stopgap; v11
    // has SERVICE_UNAVAILABLE).
    //
    // `isTransientMeiliError` covers the civitai wrapper errors
    // (MeiliCallTimeoutError = local timer / circuit-open; MeilisearchFetchError
    // with a failfast status = raw-fetch 408/429/5xx) AND the meilisearch-js
    // SDK's own error types (MeiliSearchCommunicationError /
    // MeiliSearchApiError / MeiliSearchTimeOutError) thrown by the SDK calls
    // inside the search index path. 4xx-other (malformed filter / auth) and
    // any other Error are NOT transient and still bubble as-is.
    if (isTransientMeiliError(err)) {
      // Keep a transient Meili outage ATTRIBUTABLE: the reclassified 503 would
      // otherwise vanish into the unlabeled 503 bucket. Mirror the post-filter
      // loop's counter usage (route + reason) so an outage is queryable by the
      // same label vocabulary; `iteration:'0'` (this is the single pre-filter
      // search, not the post-filter iteration loop).
      meiliFetchFailfastTotal.inc({
        route: 'getAllImagesIndex',
        iteration: '0',
        reason: failfastReasonForTransientError(err),
      });
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Image search is temporarily overloaded — please retry.',
        cause: err as Error,
      });
    }
    throw err;
  }

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
    imageMetrics,
    tagIdsVar,
    tagsVar,
  ] = await withSpan('image:getAllImagesIndex:parallelFetch', async () =>
    Promise.all([
      // These enrichment fetches are independent (each takes pre-computed
      // userIds/imageIds/videoIds/searchResults) and are issued WITHOUT awaiting
      // each element so Promise.all runs them concurrently — node-redis pipelines
      // the cache GETs queued in the same tick, collapsing ~9 sequential Redis
      // round-trips into ~1 round-trip-time. The prior version awaited each
      // element, forcing sequential evaluation (the span name was aspirational).
      // Mirrors the concurrent block in getAllImages.
      getBasicDataForUsers(userIds),
      include?.includes('profilePictures') ? getProfilePicturesForUsers(userIds) : undefined,
      include?.includes('cosmetics') ? getCosmeticsForUsers(userIds) : undefined,
      include?.includes('cosmetics')
        ? getCosmeticsForEntity({
            ids: imageIds,
            entity: 'Image',
          })
        : undefined,
      include?.includes('metaSelect') ? getMetaForImages(imageIds) : undefined,
      getMetadataForImages(videoIds), // Only need this for videos
      getThumbnailsForImages(videoIds), // Only need this for videos
      getImageMetricsObject(searchResults),
      // Fetch tagIds from cache so client-side hidden-tag filtering works.
      // Search results don't include tagIds (too expensive to store),
      // and Meilisearch tagIds may be stale, so always fetch from the authoritative cache.
      include?.includes('tagIds') ? tagIdsForImagesCache.fetch(imageIds) : undefined,
      include?.includes('tags') ? getImageTagsForImages(imageIds) : undefined,
    ])
  );

  const tagsByImageId = tagsVar
    ? tagsVar.reduce((acc, tag) => {
        const arr = acc.get(tag.imageId);
        if (arr) arr.push(tag);
        else acc.set(tag.imageId, [tag]);
        return acc;
      }, new Map<number, typeof tagsVar>())
    : undefined;

  // Visibility-check the RAW `model3dId` carried on the search docs (indexed
  // from `Post.model3dId`) before it reaches the client — same no-leak bar as
  // the raw-SQL feed path and `image.get`. Only the non-null few are resolved,
  // in ONE batched query (no per-image N+1).
  const rawIndexModel3dIds = [
    ...new Set(
      searchResults
        .map((sr) => (sr as { model3dId?: number }).model3dId)
        .filter((id): id is number => typeof id === 'number')
    ),
  ];
  const visibleIndexModel3DIds = rawIndexModel3dIds.length
    ? await getVisibleModel3DIds({
        model3dIds: rawIndexModel3dIds,
        userId: currentUserId,
        isModerator: user?.isModerator,
      })
    : undefined;

  const mergedData = withSpan('image:getAllImagesIndex:transform', () =>
    searchResults.map(({ publishedAtUnix, ...sr }) => {
      const thisUser = userDatas[sr.userId] ?? {};
      const reactions =
        userReactions?.[sr.id]?.map((r) => ({ userId: currentUserId as number, reaction: r })) ??
        [];
      const meta = imageMeta?.[sr.id]?.meta ?? null;
      const metadata = imageMetadata[sr.id]?.metadata ?? null;
      const thumbnail = thumbnails[sr.id] ?? null;
      const nsfwLevel = Math.max(thumbnail?.nsfwLevel ?? 0, sr.nsfwLevel);
      const metrics = imageMetrics[sr.id];

      // Three-state chip signal on the feed-modal path:
      //  - linked model3d (any source)  → gated number | null (no leak)
      //  - Meili doc, no link           → null (resolved-absent → chip renders
      //                                   nothing AND does NOT fall back, the
      //                                   durable elimination of getByPostId)
      // 🔴 That `null` is only correct while ONE backend serves this path. A
      // second source that does not index `model3dId` needs its own arm
      // returning `undefined`, or its chips silently stop appearing.
      const rawModel3dId = (sr as { model3dId?: number }).model3dId;
      const model3dId =
        typeof rawModel3dId === 'number'
          ? visibleIndexModel3DIds?.has(rawModel3dId)
            ? rawModel3dId
            : null
          : null;

      return {
        ...sr,
        model3dId,
        // Override tagIds from authoritative cache when available.
        // This ensures client-side hidden-tag filtering works even when
        // the search engine doesn't return tagIds.
        tagIds: tagIdsVar?.[sr.id]?.tags ?? sr.tagIds,
        modelVersionId: sr.postedToId,
        type: sr.type as MediaType,
        createdAt: sr.sortAt,
        metadata: { ...metadata, width: sr.width ?? 0, height: sr.height ?? 0 },
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
        stats: {
          likeCountAllTime: metrics?.reactionLike ?? 0,
          laughCountAllTime: metrics?.reactionLaugh ?? 0,
          heartCountAllTime: metrics?.reactionHeart ?? 0,
          cryCountAllTime: metrics?.reactionCry ?? 0,
          commentCountAllTime: metrics?.comment ?? 0,
          collectedCountAllTime: metrics?.collection ?? 0,
          tippedAmountCountAllTime: metrics?.buzz ?? 0,
          dislikeCountAllTime: 0,
          viewCountAllTime: 0,
        },
        reactions,
        cosmetic: imageCosmetics?.[sr.id] ?? null,
        // TODO fix below
        availability: Availability.Public,
        tags: tagsByImageId?.get(sr.id) ?? [],
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
    })
  );

  // For single-post queries, re-sort by image index to preserve manual ordering.
  // Search engines sort by sortAt/reactions, but posts need index-based ordering.
  if (input.postId && !input.modelVersionId && mergedData.length > 1) {
    const imageIds = mergedData.map((d) => d.id);
    const indexData = await dbRead.$queryRaw<{ id: number; index: number }[]>`
      SELECT id, COALESCE(index, 0) as index FROM "Image" WHERE id IN (${Prisma.join(imageIds)})
    `;
    const indexMap = new Map(indexData.map((d) => [d.id, d.index]));
    mergedData.sort((a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0));
  }

  let nextCursor: string | undefined;
  if (searchNextCursor) {
    nextCursor = `${offset + input.limit}|${searchNextCursor}`;
  }

  return {
    nextCursor,
    // Always-on wire trim on the DOMINANT tRPC Meili feed path: the item
    // literal above emits `scannedAt`/`mimeType`/`postTitle` as explicit `null`
    // props (plus any of IMAGE_INFINITE_DROPPED_FIELDS carried on `...sr`), which
    // still SERIALIZE even though the return type is narrowed to `Omit<...>` (a
    // `const` object literal → no excess-property check strips them). Map through
    // `stripImageForInfiniteWire` so they are actually removed from the payload,
    // matching the DB `getAllImages` path. See `~/server/utils/image-infinite-wire.ts`.
    items: mergedData.map(stripImageForInfiniteWire),
    ...(searchSource && { source: searchSource }),
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
/**
 * Owner carve-out for a `scheduled` request: own content whose publish date is
 * still in the future.
 *
 * The publish predicate is the whole point. A bare `userId = me` admits every
 * unpublished row the caller owns — drafts, bounty entry uploads, orphans — so
 * turning Scheduled on filled a creator's own profile with work they never
 * posted (ClickUp 868kt9y1w). Shared rather than inlined because all three
 * call sites had their own copy and only one of them would have been fixed.
 */
const makeOwnScheduledMeiliFilter = (currentUserId: number, snappedNow: number) =>
  `(${makeMeiliImageSearchFilter('userId', `= ${currentUserId}`)} AND ${makeMeiliImageSearchFilter(
    'publishedAtUnix',
    `> ${snappedNow}`
  )})`;

type MeiliImageSort = `${MetricsImageSortableAttribute}:${'asc' | 'desc'}`;
export const makeMeiliImageSearchSort = (
  field: MetricsImageSortableAttribute,
  criteria: 'asc' | 'desc'
): MeiliImageSort => {
  return `${field}:${criteria}`;
};

type ImageSearchInput = GetInfiniteImagesOutput & {
  useCombinedNsfwLevel?: boolean;
  domain?: DomainColor;
  currentUserId?: number;
  isModerator?: boolean;
  offset?: number;
  entry?: number;
  blockedFor?: string[];
  signal?: AbortSignal;
  actor?: string;
  // Unhandled
  //prioritizedUserIds?: number[];
  //userIds?: number | number[];
  //modelId?: number;
  //reviewId?: number;
};

/**
 * Strip the session user off a search input before it reaches a log sink.
 *
 * `getInfiniteImagesHandler` spreads the whole `ctx.user` into the search input
 * for business logic, so logging the input verbatim shipped `email`,
 * `emailVerified`, `username` and `createdAt` for every erroring search — 331k
 * records/day in production, each naming a real account.
 *
 * Nothing diagnostic is lost: of the session user, `getAllImagesIndex` forwards
 * exactly `currentUserId` (= `user?.id`) and `isModerator` into this function as
 * separate top-level keys, and both survive redaction untouched. (It also reads
 * `user?.username` for `enforceBlockedBrowsingTags`, but that is consumed in the
 * caller and never reaches this input — so the redacted payload still carries
 * every session-user field the search path actually had.)
 *
 * The user object is dropped WHOLE rather than having its known PII keys
 * deleted. A denylist fails open — the next field added to the session user
 * would silently start shipping to logs again, which is exactly how this
 * regressed. Do not "improve" this by re-adding `user` minus some keys.
 *
 * `user.id` is deliberately NOT remapped onto a `userId` key: `userId` is
 * already a *search filter* on this input (feed-by-creator), and overwriting it
 * would corrupt the logged query.
 */
export function redactSearchInputForLog<T extends Record<string, unknown>>(input: T) {
  const { user: _sessionUser, ...rest } = input as T & { user?: unknown };
  return removeEmpty(rest);
}

/**
 * Per-request tally, created by the caller and threaded through.
 *
 * NOT module-level. This process serves feed requests concurrently and every
 * `await` in the page loop yields to another one, so a module-level counter
 * would be reset and incremented by interleaving requests — request A logging
 * request B's drops. A number whose value cannot be attributed to a request is
 * not a measurement, and this counter exists precisely to attribute something.
 */

export async function getImagesFromSearch(input: ImageSearchInput) {
  let searchFn = getImagesFromSearchPreFilter;
  // Wrap Flipt feature-flag evaluation so the trace shows whether per-request
  // flag fetch is contributing to the parent span's latency. Routes through
  // getFliptBoolean instead of direct per-request wasm evaluateBoolean calls on
  // this hot feed path — once the Flipt eval cache (PR #2394) lands these become
  // memoized; today it's a behavior-preserving refactor. getFliptBoolean returns
  // false on a missing/uninitialized client, matching the prior null-client
  // fallthrough (flags default off → pre-filter).
  input = await withSpan('image:flipt:eval', async () => {
    const entityId = input.currentUserId?.toString() || 'anonymous';
    const postFilter = await getFliptBoolean(FLIPT_FEATURE_FLAGS.FEED_POST_FILTER, entityId);
    if (postFilter) searchFn = getImagesFromSearchPostFilter;
    return input;
  });

  const result = await searchFn(input);

  return { ...result, source: 'meili' as const };
}

// No applyHideChallengesExclusion here: `hideChallenges` cannot reach this function. Its only
// upstreams are /api/v1/images and /api/v1/blocks/images, whose zod objects declare neither
// `hideChallenges` nor `excludedTagIds` and strip unknown keys. Adding either key to those
// schemas would hand the REST API an unfiltered feed — apply the exclusion here first. Note
// image-search.service.ts spreads the same `data` into both branches (getAllImages / here),
// so the result wouldn't be uniformly unfiltered: one branch would filter and this one
// wouldn't, which reads as a caching bug, not a gap.
export async function getImagesFromFeedSearch(
  input: ImageSearchInput
): Promise<GetAllImagesIndexResult> {
  // The fifth filter builder, and the one with no hub clause. Unreachable today
  // only because the REST zod for /api/v1/images does not declare `hubId` and
  // strips unknown keys — the same accident the hideChallenges comment above
  // describes. Adding the key to that schema without a clause here would serve an
  // unfiltered feed from one of three branches, so fail loudly instead.
  if (input.hubId)
    throw throwInternalServerError(
      new Error('getImagesFromFeedSearch cannot serve a hub; hub queries must use the index path')
    );

  try {
    const blockedEnforcement = await enforceBlockedBrowsingTags(input, {
      id: input.currentUserId,
      isModerator: input.isModerator,
    });
    if (blockedEnforcement.emptyResult) return { nextCursor: undefined, items: [] };

    // Evaluate feature flags before creating feed. Routed through getFliptBoolean
    // (memoized once PR #2394's eval cache lands) instead of a direct per-request
    // wasm eval; it swallows errors and returns false on a missing/uninitialized
    // client, preserving the prior fail-safe default (existence check off).
    const enableExistenceCheck = await getFliptBoolean(
      FLIPT_FEATURE_FLAGS.FEED_IMAGE_EXISTENCE,
      input.currentUserId?.toString() || 'anonymous'
    );

    const feed = new ImagesFeed(
      ({ apiKey, host }: { apiKey: string; host: string }) => {
        const client = new MeiliSearch({
          host,
          apiKey,
          requestConfig: input.actor
            ? { headers: { [SEARCH_ACTOR_HEADER]: input.actor } }
            : undefined,
        });
        // Wrap the returned IMeilisearch so that only the SDK calls inside
        // event-engine-common's queryDocuments / populate go through
        // withMeili('search'). Without this narrow scope, the previous wrap
        // covered ALL of populatedQuery() — including Postgres / ClickHouse /
        // Redis work in populateDocuments — which (a) falsely attributed
        // slow DB queries as Meili timeouts and (b) held a Meili semaphore
        // slot during non-Meili work, starving real Meili callers.
        //
        // NOTE: This is defense-in-depth. Verified hot path on 2026-05-29
        // is getImagesFromSearch (above), not this feed path (REST-only,
        // 0 errors/15min). Keeping this wrap so a future traffic-shift
        // doesn't expose us again.
        return wrapMeilisearchClientWithLimiter(client) as IMeilisearch;
      },
      clickhouse as IClickhouseClient,
      pgDbWrite as IDbClient,
      new MetricService(clickhouse as IClickhouseClient, redis as unknown as IRedisClient),
      new CacheService(
        redis as unknown as IRedisClient,
        pgDbWrite as IDbClient,
        clickhouse as IClickhouseClient,
        undefined,
        // Back the feed's image→tagIds lookup with civitai's own warm, actively-invalidated
        // tagIdsForImagesCache (msgpack string) instead of the retired event-engine-common
        // `image:tagIds` Redis hash. Same {imageId, tags[]} shape + same WD14/Rekognition +
        // styleTags/subjectTags filter, so it's a drop-in. Relieves next-redis-cluster memory.
        (ids: number[]) =>
          tagIdsForImagesCache.fetch(ids) as Promise<
            Record<number, { imageId: number; tags: number[] }>
          >
      )
    );

    // Convert cursor to string if it's not already, and add feature flag result
    const feedInput = {
      ...input,
      cursor: input.cursor ? String(input.cursor) : undefined,
      enableExistenceCheck,
    };

    // No outer withMeili() here — the wrap now lives on the SDK calls inside
    // the client wrapper above. populatedQuery() does DB+CH+Redis work that
    // should NOT consume a Meili semaphore slot.
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
      // Mirror the DB path's wire trim so both `image.getInfinite` backends ship the
      // identical narrowed shape (drops any of IMAGE_INFINITE_DROPPED_FIELDS still
      // carried on the ImageDocument rest).
      items: transformedItems.map(stripImageForInfiniteWire),
    };
  } catch (err) {
    console.error('Error in getImagesFromFeedSearch:', err);
    // Any genuinely-transient upstream failure → fail fast as SERVICE_UNAVAILABLE
    // (HTTP 503) so the caller gets a fast, retryable response instead of
    // bleeding 30s while Traefik gives up. 503 is the correct transient-brownout
    // code (was TIMEOUT/408 under tRPC v10, which lacked SERVICE_UNAVAILABLE).
    //
    // `isTransientMeiliError` covers BOTH civitai's own wrapper errors
    // (MeiliCallTimeoutError / MeilisearchFetchError, from the raw-fetch path)
    // AND the meilisearch-js SDK's own error types (MeiliSearchCommunicationError /
    // MeiliSearchApiError / MeiliSearchTimeOutError) that the feed library's
    // INNER SDK calls throw on a slow/shed backend — the latter were the
    // dominant remaining HTTP-500 source on /api/v1/images (a 408/503 from the
    // proxy surfaced as a bare {"error":"Request Timeout"} / {"error":"Service
    // Unavailable"} 500 because they're not TRPCErrors and fell through the
    // generic 500 mapping). 4xx-other (malformed filter / auth) and any other
    // Error are NOT transient and still bubble as-is (→ their real status).
    const transient = isTransientMeiliError(err);
    if (transient) {
      // Keep a transient Meili outage ATTRIBUTABLE (see getAllImagesIndex). The
      // reclassified 503 would otherwise land in the unlabeled 503 bucket;
      // mirror the post-filter loop's {route, reason} so a Meili brownout is
      // queryable. `iteration:'0'` — this is the single feed-search call.
      meiliFetchFailfastTotal.inc({
        route: 'getImagesFromFeedSearch',
        iteration: '0',
        reason: failfastReasonForTransientError(err),
      });
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Image search is temporarily overloaded — please retry.',
        cause: err as Error,
      });
    }
    // TRANSIENT ClickHouse transport blip in the metric-enrichment leg of
    // populatedQuery (the event-engine-common MetricService read). The feed items
    // come from Meili+Postgres; only the display-only engagement metrics are
    // ClickHouse-backed, and they ALREADY fail-open to zero elsewhere
    // (getImageMetricsObject → {}). But this feed path runs the metric read INSIDE
    // populatedQuery, so a CH connection error (socket hang up / Code 279 / Code
    // 210) thrown there isn't a Meili error → it would fall through to `throw err`
    // → the handler's generic 500. Re-map it to the same retryable 503 as a Meili
    // brownout: a CH transport flap is a transient upstream brownout, not a server
    // bug, and 503+Retry-After lets the client/CF retry the (seconds-long) blip
    // instead of surfacing a hard 500. A CH QUERY/SCHEMA error (UNKNOWN_TABLE etc.)
    // is NOT matched by isClickHouseConnectionError and still throws → 500 → visible
    // + alertable, exactly as the missing-table incident was. No money/entitlement
    // is on this path — image metrics are display-only.
    if (isClickHouseConnectionError(err)) {
      clickhouseFailSoftCounter.inc({ path: 'image-feed' });
      logToAxiom(
        {
          type: 'warning',
          name: 'clickhouse-failsoft',
          message: 'ClickHouse transport error in image feed metric enrichment — served 503',
          path: 'image-feed',
          error: err instanceof Error ? err.message : String(err),
        },
        'clickhouse'
      ).catch();
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Image feed is temporarily overloaded — please retry.',
        cause: err as Error,
      });
    }
    throw err;
  }
}

import type { ResolvedHubSources } from '~/server/services/user-hub.service';
import { hubBrowsingLevel, resolveHubSources } from '~/server/services/user-hub.service';
import { HUB_COLLECTION_SOURCES_ENABLED } from '~/server/schema/user-hub.schema';

// The OR-group a hub's sources become. Mirrors the single-`modelVersionId`
// branch below, including its two gates: a hub must honour hideAutoResources /
// hideManualResources or it silently ignores two filters the user set.
//
// Returns null when the hub resolved to nothing. Callers must return an empty
// page for null — never fall through unfiltered, which would serve the global
// feed to someone who asked for their hub.
// The two filter builders are mutually exclusive per request and each calls this
// once, so nothing here needs memoizing. Kept as a helper so both spell the hubId
// short-circuit and the argument set identically.
async function resolvedHubSources(input: ImageSearchInput) {
  if (!input.hubId) return null;
  return resolveHubSources({
    hubId: input.hubId,
    userId: input.currentUserId,
    isModerator: input.isModerator,
    excludedSources: input.hubExcludedSources,
  });
}

type HubFilterArm = { field: MetricsImageFilterableAttribute; ids: number[] };

// The single enumeration of the arms a hub ORs together. One builder consumes it
// today (`buildHubFilter`); the split survives so a second clause syntax cannot be
// given a different set of arms.
// Returns null for "no arm", which callers must treat as "serve nothing"; treating
// it as "no filter" hands the caller the global feed as their hub.
function hubFilterArms(
  sources: ResolvedHubSources,
  {
    hideAutoResources,
    hideManualResources,
  }: Pick<ImageSearchInput, 'hideAutoResources' | 'hideManualResources'>
): HubFilterArm[] | null {
  const arms: HubFilterArm[] = [];
  if (sources.userIds.length) arms.push({ field: 'userId', ids: sources.userIds });
  if (sources.modelVersionIds.length) {
    arms.push({ field: 'postedToId', ids: sources.modelVersionIds });
    if (!hideAutoResources) arms.push({ field: 'modelVersionIds', ids: sources.modelVersionIds });
    if (!hideManualResources)
      arms.push({ field: 'modelVersionIdsManual', ids: sources.modelVersionIds });
  }
  // No guard, unlike `collectionIds` below: `tagIds` has been a live filterable
  // attribute on the metrics index since 2024, and the ids are denormalised onto the
  // documents at index time. Verified against the prod index rather than assumed —
  // a tag filter returns hits where `collectionIds IN [...]` is rejected outright.
  if (sources.tagIds.length) arms.push({ field: 'tagIds', ids: sources.tagIds });
  // Guarded, not merely unused: filtering on an attribute the index has not been
  // rebuilt with makes Meilisearch reject the entire query, which surfaces as a 503.
  if (HUB_COLLECTION_SOURCES_ENABLED && sources.collectionIds.length)
    arms.push({ field: 'collectionIds', ids: sources.collectionIds });

  return arms.length ? arms : null;
}

/**
 * The hub's keep-out group: a creator, model or version whose content the owner
 * said must not appear. ANDed as a `NOT` against everything else rather than ORed
 * into the source group — an exclusion that joins the OR is not an exclusion, it is
 * a fifth way to be included.
 *
 * Returns null for "this hub excludes nothing", which is the only safe reading of
 * an empty set: unlike `hubFilterArms`, a null here must NOT empty the page.
 *
 * The three resource arms are emitted unconditionally, where the positive builder
 * gates two of them on hideAutoResources / hideManualResources. Those gates say
 * which attributions the viewer wants to be COLLECTED by; they do not say the
 * viewer is willing to see a model the owner refused, arriving under a different
 * attribution.
 */
function buildHubExclusionFilter(sources: ResolvedHubSources): string | null {
  const { userIds, modelVersionIds, tagIds } = sources.excluded;
  const arms: HubFilterArm[] = [];
  if (userIds.length) arms.push({ field: 'userId', ids: userIds });
  if (tagIds.length) arms.push({ field: 'tagIds', ids: tagIds });
  if (modelVersionIds.length) {
    arms.push({ field: 'postedToId', ids: modelVersionIds });
    arms.push({ field: 'modelVersionIds', ids: modelVersionIds });
    arms.push({ field: 'modelVersionIdsManual', ids: modelVersionIds });
  }
  if (!arms.length) return null;

  // Verified against the prod metrics index rather than assumed: a document whose
  // `tagIds` is empty survives `NOT tagIds IN [x]`, and `NOT field IN [unused-id]`
  // returns the whole set. So a NOT arm removes matches only — it does not also
  // drop documents that lack the field.
  return `NOT (${arms
    .map((arm) => makeMeiliImageSearchFilter(arm.field, `IN [${arm.ids.join(',')}]`))
    .join(' OR ')})`;
}

function buildHubFilter(
  sources: ResolvedHubSources,
  input: Pick<ImageSearchInput, 'hideAutoResources' | 'hideManualResources'>
): string | null {
  const arms = hubFilterArms(sources, input);
  if (!arms) return null;
  return `(${arms
    .map((arm) => makeMeiliImageSearchFilter(arm.field, `IN [${arm.ids.join(',')}]`))
    .join(' OR ')})`;
}

export async function getImagesFromSearchPreFilter(input: ImageSearchInput) {
  if (!metricsSearchClient) return { data: [], nextCursor: undefined };
  let { postIds = [] } = input;

  const {
    sort,
    modelVersionId,
    model3dId,
    types,
    withMeta,
    fromPlatform,
    notPublished,
    scheduled,
    publishedOnly,
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
    newCreators,
    hubId,
    domain,
    // TODO check the unused stuff in here
  } = input;
  let { browsingLevel, userId } = input;

  const sorts: MeiliImageSort[] = [];
  const filters: string[] = [];

  // Only show images that belong to a post
  filters.push(makeMeiliImageSearchFilter('postId', 'IS NOT NULL'));

  const ownCarveOut = currentUserId ? ` OR "userId" = ${currentUserId}` : '';
  if (!isModerator) {
    filters.push(
      // Avoids exposing private resources to the public
      `((NOT availability = ${Availability.Private})${ownCarveOut})`
    );

    filters.push(
      // Avoids blocked resources to the public
      `(("blockedFor" IS NULL OR "blockedFor" NOT EXISTS)${ownCarveOut})`
    );
  }

  if (postId) {
    postIds = [...(postIds ?? []), postId];
  }

  if (disablePoi) {
    filters.push(`(NOT poi = true${ownCarveOut})`);
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
    const targetUser =
      (await dbRead.user.findUnique({ where: { username }, select: { id: true } })) ??
      (await dbWrite.user.findUnique({ where: { username }, select: { id: true } }));
    if (!targetUser) throw throwNotFoundError('User not found');
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

  // Creators on the "new & upcoming" board. Same shape as `followed` above, but the
  // set is global per domain rather than per viewer. An unpopulated board returns
  // nothing rather than degrading to the unfiltered feed.
  if (newCreators) {
    const newCreatorIds = await getNewCreatorUserIds({ entity: 'images', domain });
    if (!newCreatorIds.length) return { data: [], nextCursor: undefined };
    filters.push(makeMeiliImageSearchFilter('userId', `IN [${newCreatorIds.join(',')}]`));
  }

  if (hubId) {
    const sources = await resolvedHubSources(input);
    const hubFilter = sources && buildHubFilter(sources, input);
    if (!hubFilter) return { data: [], nextCursor: undefined };
    filters.push(hubFilter);

    // Pushed as its own AND term, and only when there is something to exclude: an
    // empty keep-out set must leave the feed alone, not empty it.
    const hubExclusionFilter = buildHubExclusionFilter(sources);
    if (hubExclusionFilter) filters.push(hubExclusionFilter);

    // The hub's own content cap, applied before the browsing-level block below
    // reads `browsingLevel`. An empty intersection is served as an empty page, not
    // as the uncapped feed the block's `if (!browsingLevel)` fallback would give it.
    const capped = hubBrowsingLevel(browsingLevel, sources);
    if (capped !== undefined) {
      if (!capped) return { data: [], nextCursor: undefined };
      browsingLevel = capped;
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
  // The caller's own unscanned uploads. Added only when there IS a caller: with no
  // `userId` clause to pair it with, this arm is every unscanned image on the site,
  // ORed past the browsing level, for anyone logged out. Signed-in behaviour is
  // unchanged.
  if (currentUserId) {
    const nsfwUserFilters = [
      makeMeiliImageSearchFilter(nsfwLevelField, `= 0`),
      makeMeiliImageSearchFilter('userId', `= ${currentUserId}`),
    ];
    nsfwFilters.push(`(${nsfwUserFilters.join(' AND ')})`);
  }
  filters.push(`(${nsfwFilters.join(' OR ')})`);

  // NSFW License Restrictions Filter
  // Filter out images with R/X/XXX NSFW levels that use restricted base models.
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

  // Model3D gallery filter — `model3dId` is the index analog of `postedToId`
  // (set at index time from `Post.model3dId`). Lets the 3D-model detail page
  // serve its gallery from Meilisearch instead of the DB feed path, which
  // was tripping the 20s ceiling on `getAllImages` for model3d queries.
  if (model3dId) {
    filters.push(makeMeiliImageSearchFilter('model3dId', `= ${model3dId}`));
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

  const snappedNow = snapToInterval(Math.round(Date.now()));
  // Hoisted above the moderator branch so a creator browsing their OWN profile
  // reaches it too. `canRequestUnpublished` is what keeps that safe: it refuses
  // unless the request is already scoped to the caller, so a non-moderator
  // cannot ask this question about the site at large. Moderator behaviour is
  // unchanged — they still answer true for any creator.
  if (notPublished && canRequestUnpublished({ isModerator, currentUserId, targetUserId: userId })) {
    filters.push(makeMeiliImageSearchFilter('publishedAtUnix', 'NOT EXISTS'));
  } else if (isModerator) {
    if (scheduled) filters.push(makeMeiliImageSearchFilter('publishedAtUnix', `> ${snappedNow}`));
    else {
      const publishedFilters = [makeMeiliImageSearchFilter('publishedAtUnix', `<= ${snappedNow}`)];
      // `publishedOnly` is the caller saying it cannot use an unpublished row at
      // all, so the moderator's own-content carve-out is lifted too. Without
      // this a moderator got their own drafts in a picker whose mutation
      // refuses them, and no other caller could opt out of that.
      if (currentUserId && !publishedOnly) {
        publishedFilters.push(makeMeiliImageSearchFilter('userId', `= ${currentUserId}`));
      }
      filters.push(`(${publishedFilters.join(' OR ')})`);
    }
  } else {
    // Non-mod path. By default, strict published-only — owners no longer see
    // their own scheduled/unpublished content pinned to feeds. The `scheduled`
    // flag is opt-in: when set, OR-in the owner carve-out so the user-own
    // second pass surfaces own scheduled hits.
    const publishedFilters: string[] = [
      makeMeiliImageSearchFilter('publishedAtUnix', `<= ${snappedNow}`),
    ];
    if (currentUserId && scheduled) {
      publishedFilters.push(makeOwnScheduledMeiliFilter(currentUserId, snappedNow));
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
    const actor = input.actor;

    // Always use the abortable raw fetch path. Two reasons:
    //   1. Client disconnect: a caller-supplied `input.signal` still cancels
    //      the underlying request as before.
    //   2. Hard local deadline: fetchDocumentsAbortable() now races against a
    //      5s default timer (FETCH_DOCUMENTS_DEFAULT_TIMEOUT_MS). Before this,
    //      the non-signal branch fell through to the SDK getDocuments, which
    //      meilisearch-js 0.33/0.34 does NOT cancel — the only protection was
    //      withMeili()'s 2.5s wrapper timer, with the orphan SDK promise still
    //      running. Routing everything through fetchDocumentsAbortable gives
    //      us one code path with a real abort, regardless of whether the
    //      caller passed a signal.
    //
    // This is the hot tRPC path
    // (image.getInfinite → getInfiniteImagesHandler → getAllImagesIndex →
    //  this prefilter). Verification on 2026-05-29 showed this is where the
    // 374-error/15min Meili bleed lives, NOT in getImagesFromFeedSearch.
    const mainResult = await withSpan('image:meili:getDocuments', () =>
      fetchDocumentsAbortable<ImageMetricsSearchIndexRecord>(METRICS_SEARCH_INDEX, request, {
        host: env.METRICS_SEARCH_HOST as string,
        apiKey: env.METRICS_SEARCH_API_KEY,
        signal: input.signal,
        actor,
      })
    );
    let results = mainResult.results;

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

    // Routed through getFliptBoolean (memoized once PR #2394's eval cache lands)
    // instead of a direct per-request wasm eval; returns false on a missing/
    // uninitialized client (existence check off), matching the prior default.
    const cacheExistenceEnabled = await getFliptBoolean(
      FLIPT_FEATURE_FLAGS.FEED_IMAGE_EXISTENCE,
      currentUserId?.toString() || 'anonymous'
    );
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

      // Check cached results first (10 minute TTL — see EX: 600 below). Fail open: image feed
      // is the highest-traffic endpoint, a sysRedis outage shouldn't 500
      // it. Treat a throw as full cache miss (everything falls through
      // to DB — slower but correct).
      let cachedResults: (string | null)[];
      try {
        // Wall-clock deadline so a silent sysRedis half-open can't park this
        // highest-traffic read ~11min (a fast DOWN already rejects into catch).
        cachedResults = await withSysReadDeadline(sysRedis.packed.mGet(cacheKeys));
      } catch (err) {
        logSysRedisFailOpen('read-degraded', 'checkImageExistence mGet', err);
        cachedResults = new Array(uniqueIds.length).fill(null);
      }

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

        // Update cache with DB results (10-minute TTL, EX: 600)
        const cacheUpdates: Record<string, string> = {};
        for (const id of uncachedIds) {
          const exists = dbIdSet.has(id);
          cacheUpdates[`${cachePrefix}${id}`] = exists ? 'true' : 'false';
          cachedMap.set(id, exists);
        }

        // Best-effort cache populate. Without this catch, the read-side
        // fail-open above is defeated: every partial-cache-miss request
        // during a sysRedis outage would still 500 here.
        await Promise.all(
          Object.entries(cacheUpdates).map(([key, value]) =>
            sysRedis.packed.set(key as RedisKeyTemplateSys, value, { EX: 600 })
          )
        ).catch((err) => {
          logSysRedisFailOpen('write-degraded', 'checkImageExistence cache populate', err);
        });
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
        input: redactSearchInputForLog(input),
        request,
      },
      'temp-search'
    ).catch();

    endTimer();
    // Let the error bubble up to tRPC. The client detects isError on the
    // infinite query and renders the retry banner — same path that handles any
    // other backend failure (API down, network blip, etc.).
    throw err;
  }
}

export async function getImagesFromSearchPostFilter(input: ImageSearchInput) {
  if (!metricsSearchClient) return { data: [], nextCursor: undefined };
  let { postIds = [] } = input;

  const {
    sort,
    modelVersionId,
    model3dId,
    types,
    withMeta,
    fromPlatform,
    notPublished,
    scheduled,
    publishedOnly,
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
    newCreators,
    hubId,
    domain,
  } = input;
  let { browsingLevel, userId } = input;

  const sorts: MeiliImageSort[] = [];
  const filters: string[] = [];

  // Only show images that belong to a post
  filters.push(makeMeiliImageSearchFilter('postId', 'IS NOT NULL'));

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
    const targetUser =
      (await dbRead.user.findUnique({ where: { username }, select: { id: true } })) ??
      (await dbWrite.user.findUnique({ where: { username }, select: { id: true } }));
    if (!targetUser) throw throwNotFoundError('User not found');
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

  if (newCreators) {
    const newCreatorIds = await getNewCreatorUserIds({ entity: 'images', domain });
    if (!newCreatorIds.length) return { data: [], nextCursor: undefined };
    filters.push(makeMeiliImageSearchFilter('userId', `IN [${newCreatorIds.join(',')}]`));
  }

  if (hubId) {
    const sources = await resolvedHubSources(input);
    const hubFilter = sources && buildHubFilter(sources, input);
    if (!hubFilter) return { data: [], nextCursor: undefined };
    filters.push(hubFilter);

    // Pushed as its own AND term, and only when there is something to exclude: an
    // empty keep-out set must leave the feed alone, not empty it.
    const hubExclusionFilter = buildHubExclusionFilter(sources);
    if (hubExclusionFilter) filters.push(hubExclusionFilter);

    // The hub's own content cap, applied before the browsing-level block below
    // reads `browsingLevel`. An empty intersection is served as an empty page, not
    // as the uncapped feed the block's `if (!browsingLevel)` fallback would give it.
    const capped = hubBrowsingLevel(browsingLevel, sources);
    if (capped !== undefined) {
      if (!capped) return { data: [], nextCursor: undefined };
      browsingLevel = capped;
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
  // Allow users to see their own unscanned content on their user page.
  if (currentUserId && userId === currentUserId)
    nsfwFilters.push(makeMeiliImageSearchFilter(nsfwLevelField, `= 0`));

  filters.push(`(${nsfwFilters.join(' OR ')})`);

  // NSFW License Restrictions Filter
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

  // Model3D gallery filter — `model3dId` is the index analog of `postedToId`
  // (set at index time from `Post.model3dId`). Lets the 3D-model detail page
  // serve its gallery from Meilisearch instead of the DB feed path, which
  // was tripping the 20s ceiling on `getAllImages` for model3d queries.
  if (model3dId) {
    filters.push(makeMeiliImageSearchFilter('model3dId', `= ${model3dId}`));
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

  // Publish Date Filtering.
  const snappedNow = snapToInterval(Date.now());
  // Hoisted above the moderator branch so a creator browsing their OWN profile
  // reaches it too — see the matching block in getImagesFromSearchPreFilter.
  if (notPublished && canRequestUnpublished({ isModerator, currentUserId, targetUserId: userId })) {
    filters.push(makeMeiliImageSearchFilter('publishedAtUnix', 'NOT EXISTS'));
  } else if (isModerator) {
    if (scheduled) filters.push(makeMeiliImageSearchFilter('publishedAtUnix', `> ${snappedNow}`));
    else {
      const publishedFilters = [makeMeiliImageSearchFilter('publishedAtUnix', `<= ${snappedNow}`)];
      // `publishedOnly` is the caller saying it cannot use an unpublished row at
      // all, so the moderator's own-content carve-out is lifted too. Without
      // this a moderator got their own drafts in a picker whose mutation
      // refuses them, and no other caller could opt out of that.
      if (currentUserId && !publishedOnly) {
        publishedFilters.push(makeMeiliImageSearchFilter('userId', `= ${currentUserId}`));
      }
      filters.push(`(${publishedFilters.join(' OR ')})`);
    }
  } else if (userId) {
    const publishedFilters: string[] = [
      makeMeiliImageSearchFilter('publishedAtUnix', `<= ${snappedNow}`),
    ];
    // For own user's profile view, only surface own scheduled content when the
    // caller explicitly opted in via the `scheduled` flag. Without opt-in, the
    // strict published filter applies even to own profile.
    if (currentUserId && userId === currentUserId && scheduled) {
      publishedFilters.push(makeOwnScheduledMeiliFilter(currentUserId, snappedNow));
    }
    filters.push(`(${publishedFilters.join(' OR ')})`);
  } else {
    // General feed queries - strict published filter for caching by default.
    // When `scheduled` is opt-in, OR-in the owner carve-out so own scheduled
    // hits surface in the main feed.
    const publishedFilters: string[] = [
      makeMeiliImageSearchFilter('publishedAtUnix', `<= ${snappedNow}`),
    ];
    if (currentUserId && scheduled) {
      publishedFilters.push(makeOwnScheduledMeiliFilter(currentUserId, snappedNow));
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
  const MAX_ITERATIONS = 5;
  const MAX_TOTAL_PROCESSED = limit * 20; // Safety limit to prevent excessive processing
  const MIN_BATCH_SIZE = limit * 2;
  const MAX_BATCH_SIZE = limit * 10;

  const accumulatedHits: ImageMetricsSearchIndexRecord[] = [];
  let currentOffset = offset || 0;
  let batchSize = MIN_BATCH_SIZE;
  let iteration = 0;
  let totalProcessed = 0;
  let consecutiveEmptyBatches = 0;
  let nextCursor: number | undefined;
  // Set true when the iteration loop breaks because the upstream signalled
  // unavailability (local deadline, 408/5xx, or circuit-open). Used after the
  // loop to distinguish "feed is genuinely empty" from "we returned nothing
  // because Meili was unhealthy" — the latter must surface as a retryable
  // TIMEOUT, not a silent empty 200 the client renders as end-of-feed.
  let brokeOnUpstreamFailure = false;
  const request: SearchParams = {
    filter: filters.join(' AND '),
    sort: sorts,
  };

  const actor = input.actor;
  // (No actorClient pinning needed here: the iteration loop now runs through
  // fetchDocumentsAbortable, which propagates `actor` via the X-Search-Actor
  // header on every request directly.)

  try {
    while (accumulatedHits.length < limit + 1 && iteration < MAX_ITERATIONS) {
      // Safety check for total processed results
      if (totalProcessed >= MAX_TOTAL_PROCESSED) {
        break;
      }

      const requestLimit = Math.min(batchSize, MAX_TOTAL_PROCESSED - totalProcessed);
      request.limit = requestLimit;
      request.offset = currentOffset;

      // Always use the abortable raw fetch path so every iteration races
      // against the same 5s hard deadline (FETCH_DOCUMENTS_DEFAULT_TIMEOUT_MS).
      // See PreFilter path for the rationale — meilisearch-js 0.33/0.34
      // getDocuments() can't be cancelled, so signal-less requests used to
      // hang the event loop on a slow backend.
      //
      // Graceful break-on-fast-fail: if a single iteration hits the local
      // deadline OR the upstream signals unavailability (408/5xx), return
      // whatever's already accumulated rather than failing the whole request.
      // iteration 1 → empty page; iteration ≥ 2 → degraded (partial) page
      // with nextCursor cleared further below. Downstream handles either
      // shape fine; the alternative (throwing) would hand the user a 5xx
      // instead of a usable feed, and clients would retry → load amplifies
      // → cascade sustains.
      //
      // Status-code rationale:
      //   - 408 (upstream-timeout)  → Meilisearch backend page-cache thrash
      //   - 503 (upstream-overload) → the feeds proxy shed (MEILI_MAX_CONCURRENT)
      //   - other 5xx               → upstream brownout / Traefik 504 / etc.
      //   - 4xx-other (400/401/403) → real client error, MUST bubble up
      let results: ImageMetricsSearchIndexRecord[];
      try {
        const fetchResult = await fetchDocumentsAbortable<ImageMetricsSearchIndexRecord>(
          METRICS_SEARCH_INDEX,
          request,
          {
            host: env.METRICS_SEARCH_HOST as string,
            apiKey: env.METRICS_SEARCH_API_KEY,
            signal: input.signal,
            actor,
          }
        );
        results = fetchResult.results;
      } catch (e) {
        const err = e as Error & { name?: string; message?: string };
        const isLocalTimeout =
          err?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
          (err?.name === 'AbortError' &&
            (err as { cause?: { message?: string } })?.cause?.message ===
              FETCH_DOCUMENTS_TIMEOUT_MESSAGE);
        if (isLocalTimeout) {
          meiliFetchFailfastTotal.inc({
            route: 'getImagesFromSearchPostFilter',
            iteration: String(iteration),
            reason: 'local-timeout',
          });
          // Fall out of the iteration loop with whatever's already in
          // accumulatedHits. The nextCursor / merge logic below handles the
          // partial case; the empty case is converted to a retryable TIMEOUT
          // after the loop (brokeOnUpstreamFailure) so the client shows its
          // retry banner instead of a silent end-of-feed.
          brokeOnUpstreamFailure = true;
          break;
        }
        // Upstream-side fast-fail: 408 (proxy/backend timeout) or 5xx
        // (overload / brownout / bad gateway). Same graceful-break shape
        // as the local-timeout path; 4xx-other re-throws below.
        if (e instanceof MeilisearchFetchError && isFailfastStatus(e.status)) {
          meiliFetchFailfastTotal.inc({
            route: 'getImagesFromSearchPostFilter',
            iteration: String(iteration),
            reason: failfastReasonForStatus(e.status),
          });
          brokeOnUpstreamFailure = true;
          break;
        }
        // Wrapper-side fail-fast: runWithLimiter said no before the request
        // touched the network — either the per-backend circuit breaker is
        // OPEN / HALF_OPEN-busy or the wrapper's MEILI_CALL_TIMEOUT_MS timer
        // fired on an SDK call. Both surface as MeiliCallTimeoutError and
        // both indicate the same operational signal: "upstream is unhealthy,
        // stop iterating". Without this branch the error re-throws and the
        // user gets a 5xx → retries → the 900/day api-primary restart wave
        // that remained after PR #2371 closed the HTTP-status paths.
        //
        // Branch order matters: this comes AFTER the local-timeout and
        // MeilisearchFetchError checks (which are sibling failure modes
        // surfaced through fetchDocumentsAbortable) and BEFORE the generic
        // re-throw, so unrelated Errors still bubble up unchanged.
        if (e instanceof MeiliCallTimeoutError) {
          meiliFetchFailfastTotal.inc({
            route: 'getImagesFromSearchPostFilter',
            iteration: String(iteration),
            reason: MEILI_FETCH_FAILFAST_REASON_CIRCUIT_OPEN,
          });
          brokeOnUpstreamFailure = true;
          break;
        }
        throw e;
      }

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

        // Own scheduled/unpublished content only passes when the caller opted
        // in via `scheduled` or `notPublished`. Without opt-in, even owners
        // get the strict published filter applied.
        if (
          (!hit.publishedAtUnix || hit.publishedAtUnix > snappedNow) &&
          !(isOwnContent && (input.scheduled || input.notPublished))
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

      // Track consecutive batches where everything was filtered out.
      // If this happens 3 times in a row, the filter likely has too few qualifying
      // results — bail out to avoid hammering Meilisearch.
      if (batchFilteredHits.length === 0) {
        consecutiveEmptyBatches++;
        if (consecutiveEmptyBatches >= 3) break;
      } else {
        consecutiveEmptyBatches = 0;
      }

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

    // If the loop bailed because Meili was unhealthy AND we accumulated
    // nothing, we have no usable page to serve. Returning an empty 200 here
    // makes the client treat it as end-of-feed (nextCursor undefined →
    // hasNextPage false → no retry), and during a brownout every feed does
    // the same, so switching feeds also shows "no results". Surface a
    // retryable 503 instead so the existing SearchRetryBanner kicks in.
    // (A non-empty partial page still serves normally — degraded, not broken.)
    if (brokeOnUpstreamFailure && accumulatedHits.length === 0) {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Image search is temporarily overloaded — please retry.',
      });
    }

    // Record PostFilter metrics
    const overallFilterRatio = totalProcessed > 0 ? 1 - accumulatedHits.length / totalProcessed : 0;
    postFilterIterations.observe({ route }, iteration);
    postFilterDocsProcessed.inc({ route }, totalProcessed);
    postFilterFilterRatio.observe({ route }, overallFilterRatio);

    const mergedHits = accumulatedHits;

    // Update nextCursor based on whether we have more results than requested
    if (mergedHits.length > limit) {
      // We have more results, so there's a next page
      const lastResult = mergedHits[limit];
      nextCursor = lastResult?.sortAtUnix || nextCursor;
    } else {
      // We don't have more results than requested, so no next page
      nextCursor = undefined;
    }

    // Trim results back to requested limit after filtering
    const limitedHits = mergedHits.slice(0, limit + 1);

    // Get all image IDs from limited results
    const searchImageIds = limitedHits.map((hit) => hit.id);
    const filteredHitIds = [...new Set(searchImageIds)];

    // Routed through getFliptBoolean (memoized once PR #2394's eval cache lands)
    // instead of a direct per-request wasm eval; returns false on a missing/
    // uninitialized client (existence check off), matching the prior default.
    const cacheExistenceEnabled = await getFliptBoolean(
      FLIPT_FEATURE_FLAGS.FEED_IMAGE_EXISTENCE,
      currentUserId?.toString() || 'anonymous'
    );
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

      // Check cached results first (10 minute TTL — see EX: 600 below). Fail open — see the
      // sibling checkImageExistence call site above for the same pattern.
      let cachedResults: (string | null)[];
      try {
        // Wall-clock deadline — see the sibling checkImageExistence call site
        // above; bounds a silent sysRedis half-open on this hot read.
        cachedResults =
          cacheKeys.length > 0 ? await withSysReadDeadline(sysRedis.packed.mGet(cacheKeys)) : [];
      } catch (err) {
        logSysRedisFailOpen('read-degraded', 'checkImageExistence mGet', err);
        cachedResults = new Array(uniqueIds.length).fill(null);
      }

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

        // Update cache with DB results (10-minute TTL, EX: 600)
        const cacheUpdates: Record<string, string> = {};
        for (const id of uncachedIds) {
          const exists = dbIdSet.has(id);
          cacheUpdates[`${cachePrefix}${id}`] = exists ? 'true' : 'false';
          cachedMap.set(id, exists);
        }

        // Best-effort cache populate — same pattern as the sibling
        // checkImageExistence above. Defeats the read-side fail-open if
        // not wrapped.
        await Promise.all(
          Object.entries(cacheUpdates).map(([key, value]) =>
            sysRedis.packed.set(key as RedisKeyTemplateSys, value, { EX: 600 })
          )
        ).catch((err) => {
          logSysRedisFailOpen('write-degraded', 'checkImageExistence cache populate', err);
        });
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
        input: redactSearchInputForLog(input),
        request,
      },
      'temp-search'
    ).catch();
    endTimer();

    throw err;
  }
}

// Lazily-built MetricService over the watcher-fed `metrics:*` cache, reused
// across calls (this is the hot feed path) rather than reconstructed per call.
let _imageMetricService: MetricService | null = null;
const getImageMetricService = () =>
  (_imageMetricService ??= new MetricService(
    clickhouse as IClickhouseClient,
    redis as unknown as IRedisClient
  ));

type ImageMetricsObject = Record<
  number,
  {
    imageId: number;
    reactionLike: number | null;
    reactionHeart: number | null;
    reactionLaugh: number | null;
    reactionCry: number | null;
    comment: number | null;
    collection: number | null;
    buzz: number | null;
  }
>;

// Image metric counts are read from the watcher-fed `metrics:*` cache via
// MetricService (which now pulls from the FINAL `entityMetricDailyAgg_v2` view).
// The legacy in-app `entitymetric:*` read path (imageMetricsCache) was retired
// after the v2 + watcher cutover went 100% stable.
export const getImageMetricsObject = async (
  data: { id: number }[]
): Promise<ImageMetricsObject> => {
  try {
    const ids = data.map((d) => d.id);

    // The ClickHouse read has NO request-level timeout other than the
    // @clickhouse/client 30s default, and a try/catch CANNOT catch a hang. Bound
    // it here so a saturated/cold-miss metric read fails SOFT to empty metrics
    // (callers treat missing ids as null) instead of parking ~30s and blowing the
    // SSR deadline. Empty `{}` matches the existing catch fallback.
    const timeoutMs = env.CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS;
    // Narrow type flows from this call (`fetch('Image', …)` → Record<number,
    // ImageMetrics>); withTimeoutFallback infers T from it so the empty fallback
    // is typed identically (no widening to the full metric union).
    const fetchPromise = getImageMetricService().fetch('Image', ids);
    type ImageMetricMap = Awaited<typeof fetchPromise>;
    const metrics = await withTimeoutFallback(fetchPromise, timeoutMs, {} as ImageMetricMap, () => {
      imageMetricsClickhouseTimeoutCounter.inc();
      logToAxiom(
        {
          type: 'warning',
          name: 'getImageMetrics timeout',
          message: `ClickHouse image metrics read exceeded ${timeoutMs}ms`,
          idCount: ids.length,
          timeoutMs,
        },
        'clickhouse'
      ).catch();
    });
    const result: ImageMetricsObject = {};
    for (const id of ids) {
      const m = metrics[id];
      result[id] = {
        imageId: id,
        reactionLike: m?.Like || null,
        reactionHeart: m?.Heart || null,
        reactionLaugh: m?.Laugh || null,
        reactionCry: m?.Cry || null,
        comment: m?.commentCount || null,
        collection: m?.Collection || null,
        buzz: m?.tippedAmount || null,
      };
    }
    return result;
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
  // Route to writer while DataPacket replica is missing ImageResourceNew backfill.
  const useWrite = await isFlipt(FLIPT_FEATURE_FLAGS.IMAGE_RESOURCE_USE_WRITE);
  const db = useWrite ? dbWrite : dbRead;
  const imageResourcesArr = await db.$queryRaw<{ imageId: number; modelVersionId: number }[]>`
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

/**
 * Narrow a pinned post's media down to what the pinned model version made.
 *
 * Media with no resource rows at all is kept: it can't be attributed either way, and
 * dropping it is what made pinned posts with videos vanish before 7518ca4f54.
 */
export async function filterPinnedImagesToVersion<T extends { id: number }>(
  images: T[],
  modelVersionId: number
) {
  if (!images.length) return images;

  const resources = await getResourceIdsForImages(images.map((x) => x.id));
  return images.filter((image) => {
    const imageResources = resources[image.id];
    return !imageResources?.length || imageResources.includes(modelVersionId);
  });
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
          Prisma.sql`i."needsReview" IS NULL AND ${imageReviewedSql()}`,
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
      // Post gates sit in the WHERE, not the JOIN: an image outlives a deleted post (`Image.postId`
      // is ON DELETE SET NULL) and an inner join drops it before ownership is tested. Nothing on
      // `Image` separates that from a never-posted upload, so only the owner may fetch a postless one.
      AND.push(
        Prisma.sql`(
          p."publishedAt" < now()
          OR p."userId" = ${userId}
          OR (i."postId" IS NULL AND i."userId" = ${userId})
        )`
      );
      AND.push(
        Prisma.sql`(i."postId" IS NULL OR p."availability" != 'Private' OR p."userId" = ${userId})`
      );
    }

    // A Blocked-level rating is a ToS removal (or a pending-Blocked verdict awaiting
    // mod review) — never serve it by direct id to anyone but the owner. Feeds already
    // drop it via the browsingLevel mask; single-image fetch had no equivalent gate.
    AND.push(Prisma.sql`(i."nsfwLevel" != ${NsfwLevel.Blocked} OR i."userId" = ${userId})`);
  }

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
      ${imageOnSiteSql()} as "onSite",
      i."meta"->'extra'->'remixOfId' as "remixOfId",
      u.id as "userId",
      u.username,
      u.image as "userImage",
      u."deletedAt",
      u."profilePictureId",
      ${
        !withoutPost
          ? Prisma.sql`
            COALESCE(p."availability", 'Public') "availability",
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
    ${Prisma.raw(withoutPost ? '' : `LEFT JOIN "Post" p ON p.id = i."postId"`)}
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

  // Durable replacement for the ambient `model3d.getByPostId` chip call: carry
  // the visibility-checked linked Model3D id on this payload (the image
  // viewers already fetch it) so the "Posted to 3D Model" chip renders from a
  // prop instead of firing a per-image tRPC query for every image (~36/s,
  // mostly null). Resolves the SAME visibility predicate the chip lookup used,
  // so a hidden draft/deleted Model3D yields null here too. Null when the post
  // isn't linked, isn't visible, or there's no postId at all.
  const model3dId = firstRawImage.postId
    ? await getVisibleModel3DIdForPost({ postId: firstRawImage.postId, userId, isModerator })
    : null;

  const image = {
    ...firstRawImage,
    model3dId,
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
  meta?: ImageMetaProps | null;
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
  db,
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
  // Optional db override. Cache lookupFn passes dbWrite during refresh() so the
  // cache always repopulates from primary; default reads still use the lagged
  // replica.
  db?: typeof dbRead;
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
    imageWhere.push(Prisma.sql`i."userId" != ALL(${excludedUserIds}::int[])`);
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
      ${Prisma.raw(
        include.includes('meta') ? 'CASE WHEN i."hideMeta" THEN NULL ELSE i.meta END AS meta,' : ''
      )}
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
      ${imageOnSiteSql()} as "onSite",
      i."meta"->'extra'->'remixOfId' as "remixOfId"
    FROM targets t
    JOIN "Image" i ON i.id = t.id
    JOIN "Post" p ON p.id = i."postId"
    ORDER BY i."postId", i."index"
  `;
  const images = await (db ?? dbRead).$queryRaw<ImagesForModelVersions[]>(query);

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
  ttl: CacheTTL.day,
  // The lookupFn filters on async-populated columns (i.nsfwLevel != 0,
  // i.needsReview IS NULL). A read between publish and ingestion-complete
  // returns zero rows. We still cache notFound to skip the requery cost on
  // versions that are genuinely empty, but cap the lifetime so a transient
  // empty doesn't pin the model out of feeds for the full 1-day TTL.
  notFoundTtl: CacheTTL.xs,
  // staleWhileRevalidate: false, // We might want to enable this later otherwise there will be a delay after a creator updates their showcase images...
  lookupFn: async (ids, fromWrite) => {
    // refresh() passes fromWrite=true. For plain fetch() misses, fall back to
    // the lag-aware helper so a cache miss right after image upload doesn't
    // poison the entry with `images: []` for a full TTL cycle.
    const db = fromWrite ? dbWrite : await getDbWithoutLagBatch('modelVersion', ids);
    // No `include: ['meta']`: these rows reach the Meilisearch model document and
    // the model.getAll wire, and GETALL_DROPPED_IMAGE_FIELDS does not drop meta.
    const images = await getImagesForModelVersion({
      modelVersionIds: ids,
      imagesPerVersion: 20,
      db,
    });

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

  if (!isModerator) {
    imageWhere.push(
      userId
        ? Prisma.sql`(i."ingestion" != 'Blocked' OR i."userId" = ${userId})`
        : Prisma.sql`i."ingestion" != 'Blocked'`
    );
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
      // postId groups images under their post server-side (post.service groups
      // on `x.postId === post.id`) AND is read on the response by
      // ImageContextMenu → ImageMenuItems (collection/view/edit/searchable menu
      // items on the browse post cards) — kept.
      postId: number;
      type: MediaType;
      metadata: ImageMetadata | VideoMetadata | null;
      onSite: boolean;
      remixOfId?: number | null;
      poi?: boolean;
      minor?: boolean;
    }[]
    // NOTE: getImagesForPosts is used ONLY by getPostsInfinite. The browse
    // cards render `images[0]` and the hidden-preferences filter reads
    // {id,userId,nsfwLevel,tagIds,poi,minor}; NO consumer reads createdAt,
    // hasMeta, or hasPositivePrompt — dropped here to cut per-image serialize
    // weight (this endpoint's payload is ~85% images at ~7 images/post, so the
    // per-image field COUNT — not the #3052 image CAP, which only trims the
    // rare >8-image gallery tail — is what drives bytes + superjson serializeMs).
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
      i."postId",
      ${imageOnSiteSql()} as "onSite",
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
    await imageResourcesCache.refresh(imageId);

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

    const voteByTagId = new Map(userVotes.map((v) => [v.tagId, v.vote]));
    for (const key in dictionary) {
      if (dictionary.hasOwnProperty(key)) {
        for (const tag of dictionary[key].tags ?? []) {
          const vote = voteByTagId.get(tag.id);
          if (vote !== undefined) tag.vote = vote > 0 ? 1 : -1;
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
  hasPositivePrompt: boolean;
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

  return attachTagsToImages(images, tagsVar);
};

export async function createImage({
  toolIds,
  techniqueIds,
  skipIngestion,
  verifiedSourceImageIds,
  ...image
}: ImageSchema & {
  userId: number;
  skipIngestion?: boolean;
  /**
   * Derivation the caller proved (see remix-provenance.ts). Nothing else can put
   * `meta.extra.sourceImageIds` on a row — every other caller's claim is stripped
   * here, so a new image path can't grant itself provenance by accident.
   */
  verifiedSourceImageIds?: number[] | null;
}) {
  const meta = sanitizeProvenance(
    image.meta as Record<string, unknown> | null | undefined,
    verifiedSourceImageIds
  );
  const result = await dbWrite.image.create({
    data: {
      ...image,
      meta: (meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: meta ? getImageGenerationProcess(meta as ImageMetaProps) : null,
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

  // No count refresh here: a new image is Pending and unpublished, so it cannot
  // satisfy the count predicate yet, and caching that zero pins it for the TTL.
  // The count is updated on the transitions that make an image countable —
  // publish and scan completion.

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
      // Same strip as `createImage`: nothing that reaches an Image row keeps a
      // provenance claim it didn't prove. These rows have no post, so they can't
      // reach a remix gallery today — but the invariant is "no unproven claim on
      // any row", not "on the rows that currently matter".
      meta:
        (sanitizeProvenance(image?.meta as Record<string, unknown> | null | undefined) as
          | Prisma.JsonObject
          | undefined) ?? Prisma.JsonNull,
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
  hideMeta: boolean;
  hasMeta: boolean;
  hasPositivePrompt: boolean;
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
          -- There is one "ImageConnection" row per linked image, so this branch --
          -- alone among the six -- can emit many rows per entity (fan-out p50 1,
          -- p99 11, max 525). DISTINCT ON collapses it to the single row the JS
          -- join below would have consumed anyway, which is what keeps the size of
          -- this result set proportional to the number of entities requested.
          --
          -- The eligibility predicate belongs HERE rather than in the outer WHERE.
          -- DISTINCT ON picks its row before any later filter runs, so collapsing
          -- first and filtering afterwards could settle on an unscanned image and
          -- leave the entity with no cover at all, even though a sibling connection
          -- was eligible the whole time.
          --
          -- Both key columns are required. Every other branch pins a single
          -- "entityType", so "entityId" alone identifies a row there; this branch
          -- joins on the pair, so one id can legitimately recur across types.
          --
          -- "ImageConnection" carries no ordering column of its own -- no index, no
          -- timestamp -- so nothing on the link records which image the author meant
          -- to come first. The tiebreak is the image id, chosen for the properties
          -- that can actually be guaranteed: it is a primary key, so the order is
          -- total, never null, and leaves no residual tie for the planner to settle
          -- arbitrarily. It is deliberately NOT claimed to be a first-attached rule.
          -- "updateEntityImages" links already-existing images -- with arbitrary older
          -- ids -- ahead of the ones it creates in the same call, so attaching an older
          -- image on a later edit lowers the minimum and promotes that image to cover.
          -- What the tiebreak buys is a stable, deterministic choice, not a
          -- semantically-first one.
          SELECT DISTINCT ON (e."entityId", e."entityType")
              e."entityId",
              e."entityType",
              i.id AS "imageId",
              0 "order1",
              0 "order2",
              0 "order3"
          FROM entities e
          JOIN "ImageConnection" ic ON ic."entityId" = e."entityId" AND ic."entityType" = e."entityType"
          JOIN "Image" i ON i.id = ic."imageId"
          WHERE i."ingestion" = 'Scanned'
            AND i."needsReview" IS NULL
          ORDER BY e."entityId", e."entityType", i.id
        ) t
    ) t
    JOIN "Image" i ON i.id = t."imageId"
    WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL`;

  // Index once instead of scanning `imagesRaw` per entity. `set` is guarded so the
  // first row for a key wins, matching what `.find()` returned: an entity can still
  // draw rows from two branches at once (an Article has both a cover image and
  // content-image connections), and this must not silently switch which one is kept.
  const imagesByEntity = new Map<string, GetEntityImageRaw>();
  for (const image of imagesRaw) {
    const key = `${image.entityId}:${image.entityType}`;
    if (!imagesByEntity.has(key)) imagesByEntity.set(key, image);
  }

  const images = entities
    .map((e) => imagesByEntity.get(`${e.entityId}:${e.entityType}`) ?? null)
    .filter(isDefined);

  let tagsVar: (VotableTagModel & { imageId: number })[] | undefined = [];
  if (include && include.includes('tags')) {
    const imageIds = images.map((i) => i.id);
    tagsVar = await getImageTagsForImages(imageIds);
  }

  const cosmetics = await getCosmeticsForEntity({ ids: images.map((i) => i.id), entity: 'Image' });

  return attachTagsToImages(images, tagsVar).map((i) => ({
    ...i,
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
  let imageRecords: {
    id: number;
    url: string;
    type: MediaType;
    width: number | null;
    height: number | null;
  }[] = [];

  if (newImages.length > 0) {
    await dbClient.image.createMany({
      data: newImages.map((image) => ({
        ...image,
        meta:
          (sanitizeProvenance(image?.meta as Record<string, unknown> | null | undefined) as
            | Prisma.JsonObject
            | undefined) ?? Prisma.JsonNull,
        userId,
        resources: undefined,
      })),
    });

    imageRecords = await dbClient.image.findMany({
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

  return imageRecords;
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
    const image = await dbRead.image.findUnique({
      where: { id },
      select: { metadata: true, postId: true },
    });
    if (!image) throw throwNotFoundError('Image not found');

    const metadata = (image.metadata as ImageMetadata) ?? undefined;
    if (activity === 'setNsfwLevelKono' && !reason) reason = 'Knights Vote';
    const updatedMetadata = { ...metadata, nsfwLevelReason: reason ?? null };

    await dbWrite.image.update({
      where: { id },
      data: { nsfwLevel, nsfwLevelLocked: true, metadata: updatedMetadata },
    });
    await imageMetadataCache.refresh(id);
    // Current meilisearch image index gets locked specially when doing a single image update due to the cheer size of this index.
    // Commenting this out should solve the problem.
    // await imagesSearchIndex.updateSync([{ id, action: SearchIndexUpdateQueueAction.Update }]);
    if (status) {
      await dbWrite.imageRatingRequest.updateMany({
        where: { imageId: id, status: 'Pending' },
        data: { status },
      });
    }
    await updateModel3DNsfwLevelForThumbnailImage({ imageId: id, postId: image.postId });
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

// NOTE(moderator-migration): getImageRatingRequests + getDownleveledImages (the image-rating-review and
// downleveled-review queues) now live in the spoke app (apps/moderator). updateImageNsfwLevel STAYS — it
// backs user rating votes + the mod APIs (set-image-nsfw-level, retool) + new-order.
// NOTE(moderator-migration): getIngestionErrorImages (the ingestion-error-review queue) now lives in the
// spoke app (apps/moderator, Kysely). resolveIngestionError STAYS — main's article-image-scan
// (resolveArticleImageScan) reuses it to pin an article image's nsfwLevel.
export async function resolveIngestionError({
  id,
  nsfwLevel,
  userId,
}: {
  id: number;
  nsfwLevel: NsfwLevel;
  userId: number;
}) {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: {
      ingestion: true,
      postId: true,
      userId: true,
      metadata: true,
    },
  });
  if (!image) throw new Error('Image not found');

  const metadata = (image.metadata as ImageMetadata) ?? {};

  await dbWrite.image.update({
    where: { id },
    data: {
      nsfwLevel,
      nsfwLevelLocked: true,
      ingestion: ImageIngestionStatus.Scanned,
      scannedAt: new Date(),
      metadata: { ...metadata, nsfwLevelReason: 'Moderator ingestion error review' },
    },
  });
  await imageMetadataCache.refresh(id);

  await tagIdsForImagesCache.refresh(id);

  if (image.postId) await updatePostNsfwLevel(image.postId);

  await queueImageSearchIndexUpdate({
    ids: [id],
    action: SearchIndexUpdateQueueAction.Update,
  });

  await trackModActivity(userId, {
    entityType: 'image',
    entityId: id,
    activity: 'setNsfwLevel',
  });
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
    onSite = isImageMetaOnSite(meta);
    if ('engine' in meta) {
      process = meta.process ?? meta.type;
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

  // On-site generations: let the generation graph decide which meta keys are
  // real generator inputs (drops computed/derived nodes + unrelated legacy
  // junk). Off-site/foreign metadata has no graph mapping, so leave undefined
  // and the client shows all keys.
  let displayKeys: string[] | undefined;
  if (onSite && meta) {
    const graphResources = resources.map((r) => ({
      id: r.modelVersionId,
      baseModel: r.baseModel,
      model: { type: r.modelType },
      strength: r.strength,
    }));
    displayKeys =
      getGenerationDisplayKeys(meta as Record<string, unknown>, graphResources) ?? undefined;
  }

  return {
    type: image.type,
    onSite,
    process,
    meta,
    displayKeys,
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
    remixOfIds: getRemixSourceIds(id, meta),
  };
}

/**
 * Every image this one was VERIFIED to have been derived from.
 *
 * `meta.extra.sourceImageIds` only. It is server-written by `sanitizeProvenance`
 * after the orchestrator workflow was checked, and nothing else can put it on a
 * row — a client-supplied value is stripped on the way in (see
 * remix-provenance.ts, and `remix-provenance.test.ts:224`, which demonstrates in
 * one assertion that an unverified `sourceImageIds` is stripped while
 * `remixOfId` survives untouched).
 *
 * ⚠️ The older `meta.extra.remixOfId` is deliberately NOT read here, and adding
 * it back is a product decision, not a bug fix. It is a client-declared claim
 * with no verification behind it, and Justin ruled on 2026-08-27 that public
 * attribution must not rest on it. This costs real coverage rather than only
 * legacy rows: measured on prod that day, 28 images carried the old field
 * against 39 with the new one over 8 hours, interleaved hour by hour with no
 * downward trend, and zero images carried both. So roughly half of all remixes
 * intentionally show no card. That is the accepted trade, not a gap to close.
 *
 * Validation goes through `storedSourceImageIds` rather than reading the field
 * directly. That is load-bearing: `sanitizeProvenance` writes `verified`
 * VERBATIM — the MAX_SOURCE_IMAGES cap lives in the three resolvers that produce
 * it, not in the sink — so nothing about a stored row bounds this list. An
 * earlier version of this comment claimed the writer capped it; it does not, and
 * the read path is where every other reader in this feature re-applies both the
 * cap and element validation.
 *
 * Exported for `__tests__/remix-of-provenance.test.ts`, which pins the exclusion
 * above by name so it cannot be quietly unioned back.
 */
export function getRemixSourceIds(
  imageId: number,
  meta: { extra?: { sourceImageIds?: number[] } } | null | undefined
) {
  // Self-reference is not a derivation, and it would render the image as its own
  // source. Dedupe as well, so a repeated id shows once.
  return [...new Set(storedSourceImageIds(meta) ?? [])].filter((sourceId) => sourceId !== imageId);
}

// LRU cache for contest collection items lookup - caches by imageId
// This avoids repeated database queries for the same image's contest participation
type ContestCollectionItem = {
  id: number;
  imageId: number;
  addedById: number | null;
  status: string;
  tag: { id: number; name: string } | null;
  collection: { id: number; name: string; metadata: Prisma.JsonValue; mode: 'Contest' };
  scores: { userId: number; score: number }[];
  rejectionReason: CollectionItemRejectionReason | null;
  rejectionDetail: string | null;
};
const contestCollectionItemsCache = createLruCache({
  name: 'contest-collection-items',
  max: 100_000,
  ttl: 30 * 60 * 1000, // 30 minutes
  keyFn: (imageId: number) => `image:${imageId}`,
  fetchFn: async (imageId: number) => {
    return dbRead.$queryRaw<ContestCollectionItem[]>`
      SELECT
        ci.id,
        ci."imageId",
        ci."addedById",
        ci.status,
        ci."rejectionReason"::text as "rejectionReason",
        ci."rejectionDetail",
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
  isModerator,
}: { userId?: number; isModerator?: boolean } & GetByIdInput) => {
  const items = await contestCollectionItemsCache.fetch(id);

  // Fetch all permissions in one query instead of N queries
  const collectionIds = items.map((i) => i.collection.id);
  const allPermissions = await getUserCollectionPermissionsByIds({
    ids: collectionIds,
    userId,
  });

  // `addedById` is destructured off rather than spread: it is only here to resolve the gate below,
  // and it names who submitted an entry, which this public endpoint has never returned.
  return items.map(({ addedById, ...i }) => {
    const permissions = allPermissions.find((p) => p.collectionId === i.collection.id);
    // This endpoint is public. The reason — and above all the reviewer's free text about
    // someone else's entry — is only for the submitter, whoever manages the collection,
    // and site moderators investigating reports about reviewer behaviour.
    const canReadRejection =
      (!!userId && userId === addedById) || !!permissions?.manage || !!isModerator;

    return {
      ...i,
      rejectionReason: canReadRejection ? i.rejectionReason : null,
      rejectionDetail: canReadRejection ? i.rejectionDetail : null,
      permissions,
      collection: {
        ...i.collection,
        metadata: (i.collection.metadata ?? {}) as CollectionMetadataSchema,
      },
    };
  });
};

// this method should hopefully not be a lasting addition
export type ModerationImageModel = AsyncReturnType<typeof getImagesByUserIdForModeration>[number];

export async function getImagesByUserIdForModeration(userId: number) {
  const { tags, meta, ...select } = imageSelect;
  return await dbRead.image.findMany({
    where: { userId },
    select,
    orderBy: { id: 'desc' },
  });
}

export function addBlockedImage({ hash, reason }: { hash: bigint; reason: BlockImageReason }) {
  return clickhouse?.insert({
    table: 'blocked_images',
    values: [{ hash: toClickhouseInt64(hash), reason }],
    format: 'JSONEachRow',
  });
}

export function bulkAddBlockedImages({
  data,
}: {
  data: { hash: bigint; reason: BlockImageReason }[];
}) {
  if (data.length === 0) return;

  const values = data.map(({ hash, reason }) => ({
    hash: toClickhouseInt64(hash),
    reason: reason.toString(),
  }));

  return clickhouse?.insert({
    table: 'blocked_images',
    values,
    format: 'JSONEachRow',
  });
}

export async function bulkRemoveBlockedImages(hashes: bigint[]) {
  if (hashes.length === 0 || !clickhouse) return;
  const blocked = await clickhouse.$query<{ hash: string; reason: string }>`
    SELECT toString(hash) AS hash, reason
    FROM "blocked_images"
    WHERE hash IN (${hashes.map(toClickhouseInt64).join(',')}) AND disabled = false
  `;

  const values = blocked.map(({ hash, reason }) => ({
    hash: toClickhouseInt64(hash),
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

// NOTE(moderator-migration): getImagesPendingIngestion (the images/to-ingest queue) now lives in the
// spoke app (apps/moderator, Kysely).

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
    await thumbnailCache.refresh(ids);
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
    thumbnailCache.refresh(imageId),
    imageMetadataCache.refresh(imageId),
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
      name: string | null;
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

  const unmatchedHashes = new Set(
    resources
      .filter((r) => r.detected && !r.modelversionid && r.hash)
      .map((r) => r.hash!.toLowerCase())
  );

  // Unguarded on purpose: an `unmatchedHashes.size > 0` guard skips the whole block for an image
  // that just became fully matched, so the warning never clears after the user uploads the model.
  const image = await dbClient.image.findUnique({
    where: { id: imageId },
    select: { meta: true },
  });

  const meta = (image?.meta ?? {}) as Record<string, any>;
  const metaResources = (meta.resources ?? []) as {
    type?: string;
    name?: string;
    hash?: string;
    unmatched?: boolean;
  }[];
  let updated = false;

  for (const resource of metaResources) {
    const unmatched = !!resource.hash && unmatchedHashes.has(resource.hash.toLowerCase());
    if (unmatched === !!resource.unmatched) continue;
    // Set false, not deleted: bundles deployed before meta.unmatchedResources read an absent key as
    // "legacy" and fall through to a count heuristic that over-reports. Removable once those are gone.
    resource.unmatched = unmatched;
    updated = true;
  }

  const unmatchedResources = deriveUnmatchedResources(resources, metaResources);
  if (!isEqual(unmatchedResources, meta.unmatchedResources ?? [])) updated = true;

  if (updated) {
    await dbClient.image.update({
      where: { id: imageId },
      data: { meta: { ...meta, resources: metaResources, unmatchedResources } },
    });
  }

  await imageResourcesCache.refresh(imageId);
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
    bucket: env.S3_IMAGE_B2_BUCKET ?? 'civitai-media-uploads',
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
  await imageMetadataCache.refresh(id);

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
  await imageMetadataCache.refresh(ids);

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
  await imageResourcesCache.refresh(imageId);
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
