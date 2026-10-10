import type { GetByIdInput } from '~/server/schema/base.schema';
import {
  imageResourcesCache,
  imageTagsCache,
  tagIdsForImagesCache,
  tagCache,
  thumbnailCache,
  imageMetadataCache,
} from '~/server/redis/caches';
import { dbRead, dbWrite } from '~/server/db/client';
import { isDefined } from '~/utils/type-guards';
import {
  getResourceIdsForImages,
  type GetImageRaw,
  getImageMetricsObject,
  model3dService,
  toImageV2Stats,
  type ContestCollectionItem,
  createImage,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import {
  type GetImageInput,
  imageMetaOutput,
  type SetVideoThumbnailInput,
  type GetMyImagesInput,
} from '~/server/schema/image.schema';
import { Prisma } from '@prisma/client';
import { imageReviewedSql } from '~/server/common/image-visibility';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { imageOnSiteSql, isImageMetaOnSite } from '~/server/utils/image-onsite';
import {
  throwNotFoundError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
} from '~/server/utils/errorHandling';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { type ModelType, MediaType, ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { getGenerationDisplayKeys } from '~/server/services/orchestrator/legacy-metadata-mapper';
import { storedSourceImageIds } from '~/server/services/orchestrator/remix-provenance';
import { createLruCache } from '~/server/utils/lru-cache';
import { getUserCollectionPermissionsByIds } from '~/server/services/collection.service';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-lag-helpers';
import { pickClientImageColumns } from '~/server/utils/image-columns';
import type { VideoMetadata } from '~/server/schema/media.schema';
import {
  publishedOrEntryDraftImageWhere,
  publishedImageWhere,
} from '~/server/selectors/image.selector';
import { TRPCError } from '@trpc/server';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { logToAxiom } from '~/server/logging/client';

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

export async function getTagNamesForImages(imageIds: number[]) {
  const tagIds = await tagIdsForImagesCache.fetch(imageIds);
  const tags = await tagCache.fetch(Object.values(tagIds).flatMap((x) => x.tags));
  const imageTags = Object.fromEntries(
    Object.entries(tagIds).map(([k, v]) => [k, v.tags.map((t) => tags[t]?.name).filter(isDefined)])
  ) as Record<number, string[]>;
  return imageTags;
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
    ? await (
        await model3dService()
      ).getVisibleModel3DIdForPost({ postId: firstRawImage.postId, userId, isModerator })
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
    stats: toImageV2Stats(match),
    reactions: userId ? reactions?.map((r) => ({ userId, reaction: r })) ?? [] : [],
  };

  return image;
};

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

  let thumbnailId: number | undefined;
  if (customThumbnail) {
    const thumbnail = await createImage({
      ...pickClientImageColumns(customThumbnail),
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

export const getMyImages = async ({
  mediaTypes,
  publishedOnly,
  includeEntryDrafts,
  userId,
  limit,
  cursor = 0,
}: GetMyImagesInput & { userId: number }) => {
  const allowedMediaTypes = mediaTypes.filter((x) => x !== MediaType.audio);

  try {
    const media = await dbRead.image.findMany({
      // `metadata` carries a video's duration, which the crucible picker needs to grey out clips
      // over a crucible's maxClipSeconds before the user spends a click on them.
      select: {
        id: true,
        url: true,
        meta: true,
        metadata: true,
        createdAt: true,
        type: true,
        nsfwLevel: true,
        ingestion: true,
      },
      where: {
        userId,
        type: {
          in: allowedMediaTypes.length ? allowedMediaTypes : [MediaType.image, MediaType.video],
        },
        postId: { not: null },
        // Published-only callers render still-scanning images as pending rather than hiding them.
        ingestion: publishedOnly
          ? { in: [ImageIngestionStatus.Pending, ImageIngestionStatus.Scanned] }
          : ImageIngestionStatus.Scanned,
        ...(publishedOnly && includeEntryDrafts
          ? publishedOrEntryDraftImageWhere()
          : publishedOnly
          ? publishedImageWhere()
          : {}),
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
