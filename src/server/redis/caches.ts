import type { ResourceInfo } from '@civitai/client';
import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { env } from '~/env/server';
import type { BaseModelType } from '~/server/common/constants';
import { CacheTTL, constants } from '~/server/common/constants';
import type { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import type { ProfileImage } from '~/server/selectors/image.selector';
import { type ImageTagComposite, imageTagCompositeSelect } from '~/server/selectors/tag.selector';
import type { EntityAccessDataType } from '~/server/services/common.service';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getModelClient } from '~/server/services/orchestrator/models';
import type { CachedObject } from '~/server/utils/cache-helpers';
import { createCachedObject } from '~/server/utils/cache-helpers';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { stringifyAIR } from '~/shared/utils/air';
import type { Availability, CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import { CosmeticEntity, ModelStatus, TagSource, TagType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

const alwaysIncludeTags = [...constants.imageTags.styles, ...constants.imageTags.subjects];
export const tagIdsForImagesCache = createCachedObject<{
  imageId: number;
  tags: number[];
}>({
  key: REDIS_KEYS.CACHES.TAG_IDS_FOR_IMAGES,
  idKey: 'imageId',
  ttl: CacheTTL.day,
  async lookupFn(imageId, fromWrite) {
    const imageIds = Array.isArray(imageId) ? imageId : [imageId];
    const db = fromWrite ? dbWrite : dbRead;

    const imageTags = await db.tagsOnImageDetails.findMany({
      where: { imageId: { in: imageIds }, disabled: false },
      select: {
        imageId: true,
        source: true,
        tagId: true,
      },
    });

    const tagIds = imageTags.map((t) => t.tagId);
    const tags = await tagCache.fetch(tagIds);

    const hasWD: { [p: string]: boolean } = {};
    for (const row of imageTags) {
      const imageIdStr = row.imageId.toString();
      hasWD[imageIdStr] ??= false;
      if (row.source === TagSource.WD14) hasWD[imageIdStr] = true;
    }
    const result = imageTags.reduce((acc, { tagId, imageId, source }) => {
      const imageIdStr = imageId.toString();
      acc[imageIdStr] ??= { imageId, tags: [] };

      const tag = tags[tagId];
      if (!tag) return acc;

      let canAdd = true;
      if (source === TagSource.Rekognition && hasWD[imageIdStr as keyof typeof hasWD]) {
        if (tag.type !== TagType.Moderation && tag.name && !alwaysIncludeTags.includes(tag.name)) {
          canAdd = false;
        }
      }

      if (canAdd) acc[imageIdStr].tags.push(tagId);
      return acc;
    }, {} as Record<string, { imageId: number; tags: number[] }>);
    return result;
  },
});

type UserCosmeticLookup = {
  userId: number;
  cosmetics: {
    cosmeticId: number;
    data: Prisma.JsonValue;
  }[];
};
export const userCosmeticCache = createCachedObject<UserCosmeticLookup>({
  key: REDIS_KEYS.CACHES.USER_COSMETICS,
  idKey: 'userId',
  staleWhileRevalidate: false, // To avoid delay in creator seeing new cosmetics
  lookupFn: async (ids) => {
    const userCosmeticsRaw = await dbRead.userCosmetic.findMany({
      where: { userId: { in: ids }, equippedAt: { not: null }, equippedToId: null },
      select: {
        userId: true,
        cosmeticId: true,
        data: true,
      },
    });
    const results = userCosmeticsRaw.reduce((acc, { userId, cosmeticId, data }) => {
      acc[userId] ??= { userId, cosmetics: [] };
      acc[userId].cosmetics.push({ cosmeticId, data });
      return acc;
    }, {} as Record<number, UserCosmeticLookup>);
    return results;
  },
  ttl: CacheTTL.day,
});

type CosmeticLookup = {
  id: number;
  name: string;
  type: CosmeticType;
  data: Prisma.JsonValue;
  source: CosmeticSource;
};
export const cosmeticCache = createCachedObject<CosmeticLookup>({
  key: REDIS_KEYS.CACHES.COSMETICS,
  idKey: 'id',
  lookupFn: async (ids) => {
    const cosmetics = await dbRead.cosmetic.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, type: true, data: true, source: true },
    });
    return Object.fromEntries(cosmetics.map((x) => [x.id, x]));
  },
  ttl: CacheTTL.day,
});

export const profilePictureCache = createCachedObject<ProfileImage>({
  key: REDIS_KEYS.CACHES.PROFILE_PICTURES,
  idKey: 'userId',
  staleWhileRevalidate: false, // To avoid delay in creator seeing their new profile picture
  lookupFn: async (ids) => {
    const profilePictures = await dbRead.$queryRaw<ProfileImage[]>`
      SELECT
        i.id,
        i.name,
        i.url,
        i."nsfwLevel",
        i.hash,
        i."userId",
        i.ingestion,
        i.type,
        i.width,
        i.height,
        i.metadata
      FROM "User" u
      JOIN "Image" i ON i.id = u."profilePictureId"
      WHERE u.id IN (${Prisma.join(ids as number[])})
    `;
    return Object.fromEntries(profilePictures.map((x) => [x.userId, x]));
  },
  ttl: CacheTTL.day,
});

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

type EntityCosmeticLookupRaw = {
  equippedToId: number;
  cosmeticId: number;
  claimKey: string;
  userData: Prisma.JsonValue;
};
export const cosmeticEntityCaches = Object.fromEntries(
  Object.values(CosmeticEntity).map((entity) => [
    entity as CosmeticEntity,
    createCachedObject<WithClaimKey<ContentDecorationCosmetic>>({
      key: `${REDIS_KEYS.CACHES.COSMETICS}:${entity}`,
      idKey: 'equippedToId',
      cacheNotFound: false,
      staleWhileRevalidate: false,
      lookupFn: async (ids) => {
        const entityCosmetics = await dbWrite.$queryRaw<EntityCosmeticLookupRaw[]>`
          SELECT uc."cosmeticId", uc."equippedToId", uc."claimKey", uc."data" as "userData"
          FROM "UserCosmetic" uc
          WHERE uc."equippedToId" IN (${Prisma.join(ids as number[])})
            AND uc."equippedToType" = '${Prisma.raw(entity)}'::"CosmeticEntity";
        `;
        return Object.fromEntries(
          entityCosmetics.map((x) => [
            x.equippedToId,
            // Hack here so we can fix it in the appendFn
            x as any as WithClaimKey<ContentDecorationCosmetic>,
          ])
        );
      },
      appendFn: async (records) => {
        const rawRecords = records as any as Set<EntityCosmeticLookupRaw>;
        const cosmeticIds = [...new Set(Array.from(rawRecords).map((x) => x.cosmeticId))];
        const cosmetics = await cosmeticCache.fetch(cosmeticIds);

        for (const record of records) {
          const rawRecord = record as any as EntityCosmeticLookupRaw;
          const cosmetic = cosmetics[rawRecord.cosmeticId];
          if (!cosmetic) continue;

          // Swap the id field to the cosmeticId
          record.id = rawRecord.cosmeticId;
          delete (record as any).cosmeticId;

          // Add userData to the data field
          record.data = cosmetic.data as ContentDecorationCosmetic['data'];
          if (rawRecord.userData) {
            const userData = rawRecord.userData as ContentDecorationCosmetic['data'];
            if (userData.lights) record.data.lights = userData.lights;
            delete (record as any).userData;
          }
        }
      },
      ttl: CacheTTL.day,
    }),
  ])
) as Record<CosmeticEntity, CachedObject<WithClaimKey<ContentDecorationCosmetic>>>;

type CachedUserMultiplier = {
  userId: number;
  rewardsMultiplier: number;
  purchasesMultiplier: number;
};
export const userMultipliersCache = createCachedObject<CachedUserMultiplier>({
  key: REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER,
  idKey: 'userId',
  ttl: CacheTTL.day,
  lookupFn: async (ids) => {
    if (ids.length === 0) return {};

    const multipliers = await dbRead.$queryRaw<CachedUserMultiplier[]>`
      SELECT
        u.id as "userId",
        CASE
          WHEN u."rewardsEligibility" = 'Ineligible'::"RewardsEligibility" THEN 0
          WHEN cs.status NOT IN ('active', 'trialing') THEN 1
          ELSE COALESCE((p.metadata->>'rewardsMultiplier')::float, 1)
        END as "rewardsMultiplier",
        CASE
          WHEN cs.status NOT IN ('active', 'trialing') THEN 1
          ELSE COALESCE((p.metadata->>'purchasesMultiplier')::float, 1)
        END as "purchasesMultiplier"
      FROM "User" u
      LEFT JOIN "CustomerSubscription" cs ON u.id = cs."userId"
      LEFT JOIN "Product" p ON p.id = cs."productId"
      WHERE u.id IN (${Prisma.join(ids)});
    `;

    const records: Record<number, CachedUserMultiplier> = Object.fromEntries(
      multipliers.map((m) => [m.userId, m])
    );

    return records;
  },
});

type UserBasicLookup = {
  id: number;
  image: string | null;
  username: string | null;
  deletedAt: Date | null;
};
export const userBasicCache = createCachedObject<UserBasicLookup>({
  key: REDIS_KEYS.CACHES.BASIC_USERS,
  idKey: 'id',
  lookupFn: async (ids) => {
    const goodIds = ids.filter(isDefined);
    if (!goodIds.length) return {};
    const userBasicData = await dbRead.user.findMany({
      where: { id: { in: goodIds } },
      select: {
        id: true,
        username: true,
        deletedAt: true,
        image: true,
      },
    });
    return Object.fromEntries(userBasicData.map((x) => [x.id, x]));
  },
  ttl: CacheTTL.day,
});

type ModelVersionAccessCache = EntityAccessDataType & { publishedAt: Date; status: ModelStatus };

export const modelVersionAccessCache = createCachedObject<ModelVersionAccessCache>({
  key: REDIS_KEYS.CACHES.ENTITY_AVAILABILITY.MODEL_VERSIONS,
  idKey: 'entityId',
  ttl: CacheTTL.day,
  cacheNotFound: false,
  dontCacheFn: (data) => {
    // We only wanna cache public models. Otherwise, we better confirm every time. It's a safer bet.
    // Also, only cache it if it's been published for more than an hour.
    const oneHourAgo = dayjs().subtract(1, 'hour').toDate();
    const isOlderThanOneHour = data.publishedAt < oneHourAgo;

    return (
      data.availability !== 'Public' ||
      !isOlderThanOneHour ||
      !data.publishedAt ||
      // No point in caching stuff in testing or unpublished
      data.status !== ModelStatus.Published
    );
  },
  lookupFn: async (ids) => {
    const goodIds = ids.filter(isDefined);
    if (!goodIds.length) return {};
    const entityAccessData = await dbRead.$queryRaw<ModelVersionAccessCache[]>(Prisma.sql`
      SELECT
        mv.id AS "entityId",
        mmv."userId" AS "userId",
        -- Model availability prevails if it's private
        CASE
          WHEN mmv.availability = 'Private'
            THEN mmv."availability"
          ELSE mv."availability"
        END AS "availability",
        mv."publishedAt" AS "publishedAt",
        mv."status" as "status"
      FROM "ModelVersion" mv
           JOIN "Model" mmv ON mv."modelId" = mmv.id
      WHERE
        mv.id IN (${Prisma.join(goodIds, ',')})
    `);
    return Object.fromEntries(entityAccessData.map((x) => [x.entityId, x]));
  },
});

type TagLookup = {
  id: number;
  name: string | null;
  type: TagType;
  nsfwLevel: NsfwLevel;
  unlisted?: true;
};
export const tagCache = createCachedObject<TagLookup>({
  key: REDIS_KEYS.CACHES.BASIC_TAGS,
  idKey: 'id',
  lookupFn: async (ids) => {
    const tagBasicData = await dbRead.tag.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        nsfwLevel: true,
        type: true,
        unlisted: true,
      },
    });
    return Object.fromEntries(
      tagBasicData.map(({ unlisted, ...x }) => [x.id, { ...x, unlisted: unlisted || undefined }])
    );
  },
  ttl: CacheTTL.day,
});

type ModelVersionDetails = {
  id: number;
  name: string;
  earlyAccessTimeFrame: number;
  baseModel: BaseModel;
  baseModelType: BaseModelType;
  createdAt: Date;
  trainingStatus: string;
  description: string;
  trainedWords?: string[];
  vaeId: number | null;
  publishedAt: Date | null;
  status: ModelStatus;
  covered: boolean;
  availability: Availability;
  nsfwLevel: NsfwLevel;
};
type ModelDataCache = {
  modelId: number;
  hashes: string[];
  tags: { tagId: number; name: string }[];
  versions: ModelVersionDetails[];
};
export const dataForModelsCache = createCachedObject<ModelDataCache>({
  key: REDIS_KEYS.CACHES.DATA_FOR_MODEL,
  idKey: 'modelId',
  ttl: CacheTTL.day,
  cacheNotFound: false,
  staleWhileRevalidate: false,
  lookupFn: async (ids, fromWrite) => {
    const db = fromWrite ? dbWrite : dbRead;

    const versions = await db.$queryRaw<(ModelVersionDetails & { modelId: number })[]>`
      SELECT
        mv."id",
        mv.index,
        mv."modelId",
        mv."name",
        mv."earlyAccessTimeFrame",
        mv."baseModel",
        mv."baseModelType",
        mv."createdAt",
        mv."trainingStatus",
        mv."publishedAt",
        mv."status",
        mv.availability,
        mv."nsfwLevel",
        mv."description",
        mv."trainedWords",
        mv."vaeId",
        COALESCE((
          SELECT gc.covered
          FROM "GenerationCoverage" gc
          WHERE gc."modelVersionId" = mv.id
        ), false) AS covered
      FROM "ModelVersion" mv
      WHERE mv."modelId" IN (${Prisma.join(ids)})
      ORDER BY mv."modelId", mv.index;
    `;

    const hashes = await db.$queryRaw<{ modelId: number; hash: string }[]>`
      SELECT "modelId", hash
      FROM "ModelHash"
      WHERE
        "modelId" IN (${Prisma.join(ids)})
        AND "hashType" = 'SHA256'
        AND "fileType" IN ('Model', 'Pruned Model');
    `;

    const results = versions.reduce((acc, { modelId, ...version }) => {
      acc[modelId] ??= { modelId, hashes: [], tags: [], versions: [] };
      acc[modelId].versions.push(version);
      return acc;
    }, {} as Record<number, ModelDataCache>);
    for (const { modelId, hash } of hashes) results[modelId]?.hashes.push(hash);
    return results;
  },
  appendFn: async (records) => {
    const modelIds = [...records].map((x) => x.modelId);
    const modelTags = await modelTagCache.fetch(modelIds);

    for (const record of records) {
      const modelTagsData = modelTags[record.modelId];
      if (!modelTagsData) continue;
      record.tags = modelTagsData.tags.map((x) => ({ tagId: x.id, name: x.name! }));
    }
  },
});

type UserContentOverview = {
  id: number;
  modelCount: number;
  imageCount: number;
  videoCount: number;
  postCount: number;
  articleCount: number;
  bountyCount: number;
  bountyEntryCount: number;
  hasReceivedReviews: boolean;
  collectionCount: number;
};

export const userContentOverviewCache = createCachedObject<UserContentOverview>({
  key: REDIS_KEYS.CACHES.OVERVIEW_USERS,
  idKey: 'id',
  lookupFn: async (ids) => {
    const goodIds = ids.filter(isDefined);
    if (!goodIds.length) return {};

    const userOverviewData = await dbRead.$queryRaw<UserContentOverview[]>`
    SELECT
        u.id,
        (SELECT COUNT(*)::INT FROM "Model" m WHERE m."userId" = u.id AND m."status" = 'Published' AND m.availability != 'Private') as "modelCount",
        (SELECT COUNT(*)::INT FROM "Post" p WHERE p."userId" = u.id AND p."publishedAt" IS NOT NULL AND p.availability != 'Private') as "postCount",
        COALESCE(im."imageCount"::INT, 0) as "imageCount",
        COALESCE(im."videoCount"::INT, 0) as "videoCount",
        (SELECT COUNT(*)::INT FROM "Article" a WHERE a."userId" = u.id AND a."publishedAt" IS NOT NULL AND a."publishedAt" <= NOW() AND a.availability != 'Private' AND a.status = 'Published'::"ArticleStatus") as "articleCount",
        (SELECT COUNT(*)::INT FROM "Bounty" b WHERE b."userId" = u.id AND b."startsAt" <= NOW() AND b.availability != 'Private') as "bountyCount",
        (SELECT COUNT(*)::INT FROM "BountyEntry" be WHERE be."userId" = u.id) as "bountyEntryCount",
        (SELECT EXISTS (SELECT 1 FROM "ResourceReview" r INNER JOIN "Model" m ON m.id = r."modelId" AND m."userId" = u.id WHERE r."userId" != u.id)) as "hasReceivedReviews",
        (SELECT COUNT(*)::INT FROM "Collection" c WHERE c."userId" = u.id AND c."read" = 'Public' AND c.availability != 'Private') as "collectionCount"
    FROM "User" u
    CROSS JOIN LATERAL (
        SELECT
            SUM(IIF(i."type" =  'image', 1, 0)) as "imageCount",
            SUM(IIF(i."type" =  'video', 1, 0)) as "videoCount"
        FROM "Image" i
        WHERE i."userId" = u.id
        AND i."postId" NOT IN
        (
            SELECT p."id"
            FROM "Post" p
            WHERE p."userId" = u.id
            AND (p."publishedAt" IS NULL OR p."availability" = 'Private')
        )
        AND i."ingestion" = 'Scanned'
        AND i."needsReview" IS NULL
    ) im
    WHERE u.id IN (${Prisma.join(goodIds)})
  `;

    return Object.fromEntries(userOverviewData.map((x) => [x.id, x]));
  },
  ttl: CacheTTL.day,
});

type ImageWithMeta = {
  id: number;
  meta?: ImageMetaProps | null;
};

export const imageMetaCache = createCachedObject<ImageWithMeta>({
  key: REDIS_KEYS.CACHES.IMAGE_META,
  idKey: 'id',
  lookupFn: async (ids) => {
    const images = await dbRead.$queryRaw<ImageWithMeta[]>`
      SELECT
        i.id,
        (CASE WHEN i."hideMeta" = TRUE THEN NULL ELSE i.meta END) as "meta"
      FROM "Image" i
      WHERE i.id IN (${Prisma.join(ids as number[])})
    `;
    return Object.fromEntries(images.map((x) => [x.id, x]));
  },
  ttl: CacheTTL.hour,
});

type ImageWithMetadata = {
  id: number;
  metadata?: ImageMetadata | VideoMetadata | null;
};

export const imageMetadataCache = createCachedObject<ImageWithMetadata>({
  key: REDIS_KEYS.CACHES.IMAGE_METADATA,
  idKey: 'id',
  lookupFn: async (ids) => {
    const images = await dbRead.$queryRaw<ImageWithMetadata[]>`
      SELECT
        i.id,
        i.metadata
      FROM "Image" i
      WHERE i.id IN (${Prisma.join(ids as number[])})
    `;
    return Object.fromEntries(images.map((x) => [x.id, x]));
  },
  ttl: CacheTTL.hour,
});

export const thumbnailCache = createCachedObject<{
  id: number;
  url: string;
  nsfwLevel: NsfwLevel;
  parentId?: number;
}>({
  key: REDIS_KEYS.CACHES.THUMBNAILS,
  idKey: 'parentId',
  lookupFn: async (ids) => {
    if (ids.length === 0) return {};

    const targets = await dbRead.$queryRaw<{ thumbnailId: string }[]>`
        SELECT
          cast(metadata->'thumbnailId' as int) as "thumbnailId"
        FROM "Image"
        WHERE id IN (${Prisma.join(ids as number[])})
          AND type = 'video'::"MediaType"
      `;

    const thumbnailIds = targets.map((x) => x.thumbnailId).filter(isDefined);
    if (thumbnailIds.length === 0) return {};

    const thumbnails = await dbRead.$queryRaw<
      { id: number; url: string; nsfwLevel: NsfwLevel; parentId: number }[]
    >`
        SELECT
          id,
          url,
          "nsfwLevel",
          cast(metadata->'parentId' as int) as "parentId"
        FROM "Image"
        WHERE id IN (${Prisma.join(thumbnailIds)})
      `;

    return Object.fromEntries(thumbnails.filter((x) => !!x.parentId).map((x) => [x.parentId, x]));
  },
  dontCacheFn: (data) => !data.nsfwLevel,
  ttl: CacheTTL.day,
});

type ImageMetricLookup = {
  imageId: number;
  reactionLike: number | null;
  reactionHeart: number | null;
  reactionLaugh: number | null;
  reactionCry: number | null;
  comment: number | null;
  collection: number | null;
  buzz: number | null;
};
export const imageMetricsCache = createCachedObject<ImageMetricLookup>({
  key: REDIS_KEYS.CACHES.IMAGE_METRICS,
  idKey: 'imageId',
  lookupFn: async (ids) => {
    const imageMetric = await dbRead.entityMetricImage.findMany({
      where: { imageId: { in: ids } },
      select: {
        imageId: true,
        reactionLike: true,
        reactionHeart: true,
        reactionLaugh: true,
        reactionCry: true,
        // reactionTotal: true,
        comment: true,
        collection: true,
        buzz: true,
      },
    });
    return Object.fromEntries(imageMetric.map((x) => [x.imageId, x]));
  },
  ttl: CacheTTL.sm,
});

type UserFollowsCacheItem = {
  userId: number;
  follows: number[];
};
export const userFollowsCache = createCachedObject<UserFollowsCacheItem>({
  key: REDIS_KEYS.CACHES.USER_FOLLOWS,
  idKey: 'userId',
  lookupFn: async (ids) => {
    const userFollows = await dbRead.userEngagement.findMany({
      where: { userId: { in: ids }, type: 'Follow' },
      select: { userId: true, targetUserId: true },
    });
    const result = userFollows.reduce((acc, { userId, targetUserId }) => {
      acc[userId] ??= { userId, follows: [] };
      acc[userId].follows.push(targetUserId);
      return acc;
    }, {} as Record<number, UserFollowsCacheItem>);
    return result;
  },
  ttl: CacheTTL.day,
  staleWhileRevalidate: false,
});
export async function getUserFollows(userId: number) {
  const userFollows = await userFollowsCache.fetch(userId);
  return userFollows[userId]?.follows ?? [];
}

type ImageTagsCacheItem = {
  imageId: number;
  tags: ImageTagComposite[];
};

export const imageTagsCache = createCachedObject<ImageTagsCacheItem>({
  key: REDIS_KEYS.CACHES.IMAGE_TAGS,
  idKey: 'imageId',
  ttl: CacheTTL.day,
  staleWhileRevalidate: false,
  lookupFn: async (ids, fromWrite) => {
    const db = fromWrite ? dbWrite : dbRead;

    const imageTags = await db.imageTag.findMany({
      where: { imageId: { in: ids } },
      select: {
        imageId: true,
        ...imageTagCompositeSelect,
      },
      orderBy: [{ score: 'desc' }, { tagId: 'asc' }],
      take: 100,
    });

    const result = imageTags.reduce((acc, tag) => {
      const { imageId, ...tagData } = tag;
      acc[imageId] ??= { imageId, tags: [] };
      acc[imageId].tags.push(tagData);
      return acc;
    }, {} as Record<number, ImageTagsCacheItem>);

    return result;
  },
});

type ModelTagCacheItem = {
  modelId: number;
  tagIds: number[];
  tags: TagLookup[];
};
export const modelTagCache = createCachedObject<ModelTagCacheItem>({
  key: REDIS_KEYS.CACHES.MODEL_TAGS,
  idKey: 'modelId',
  staleWhileRevalidate: false, // To avoid delay in creator seeing their new tags
  lookupFn: async (ids) => {
    const modelTags = await dbRead.tagsOnModels.findMany({
      where: { modelId: { in: ids } },
      select: { modelId: true, tagId: true },
    });
    const result = modelTags.reduce((acc, { modelId, tagId }) => {
      acc[modelId] ??= { modelId, tagIds: [] } as unknown as ModelTagCacheItem; // Hack so we don't need to store empty tags array
      acc[modelId].tagIds.push(tagId);
      return acc;
    }, {} as Record<number, ModelTagCacheItem>);
    return result;
  },
  appendFn: async (records) => {
    const tagIds = [...records].flatMap((x) => x.tagIds);
    const tags = await tagCache.fetch(tagIds);

    for (const record of records) {
      record.tags = record.tagIds.map((tagId) => tags[tagId]).filter(isDefined);
    }
  },
  ttl: CacheTTL.day,
});

export type ModelVersionResourceCacheItem = {
  versionId: number;
  popularityRank: number | null;
  isFeatured: boolean;
  isNew: boolean;
};
export const modelVersionResourceCache = createCachedObject<ModelVersionResourceCacheItem>({
  key: REDIS_KEYS.CACHES.MODEL_VERSION_RESOURCE_INFO,
  idKey: 'versionId',
  ttl: CacheTTL.md,
  lookupFn: async (ids) => {
    const mvInfo = await dbRead.modelVersion.findMany({
      where: { id: { in: ids } },
      select: { id: true, baseModel: true, model: { select: { id: true, type: true } } },
    });

    const versionInfo = await Promise.all(
      mvInfo.map(async (v) => {
        try {
          const md = await getModelClient({
            token: env.ORCHESTRATOR_ACCESS_TOKEN,
            air: stringifyAIR({
              baseModel: v.baseModel,
              type: v.model.type,
              modelId: v.model.id,
              id: v.id,
            }),
          });
          if (!md || !!md.error)
            return {
              popularityRank: 0,
              isFeatured: false,
              isNew: false,
              id: v.id,
            };

          const data: ResourceInfo = md.data;
          const isNew = !!data.publishedAt
            ? dayjs(data.publishedAt).isAfter(dayjs().subtract(7, 'day'))
            : false;

          return {
            popularityRank: data.popularityRank ?? 0,
            isFeatured: data.isFeatured ?? false,
            isNew,
            id: v.id,
          };
        } catch (e) {
          console.error(e);
          return {
            popularityRank: 0,
            isFeatured: false,
            isNew: false,
            id: v.id,
          };
        }
      })
    );

    return Object.fromEntries(
      versionInfo.map((vi) => [
        vi.id,
        {
          versionId: vi.id,
          popularityRank: vi.popularityRank ?? 0,
          isFeatured: vi.isFeatured ?? false,
          isNew: vi.isNew ?? false,
        },
      ])
    );
  },
});
