import type { ResourceInfo } from '@civitai/client';
import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import type { BaseModelType } from '~/server/common/constants';
import { CacheTTL } from '~/server/common/constants';
import type { NsfwLevel } from '~/server/common/enums';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import type { ProfileImage } from '~/server/selectors/image.selector';
import { type ImageTagComposite, imageTagCompositeSelect } from '~/server/selectors/tag.selector';
import type { EntityAccessDataType } from '~/server/services/common.service';
import { getModelClient } from '~/server/services/orchestrator/models';
import type { CachedObject } from '~/server/utils/cache-helpers';
import { createCachedObject } from '~/server/utils/cache-helpers';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { stringifyAIR } from '~/shared/utils/air';
import dayjs from '~/shared/utils/dayjs';
import type { Availability, CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import { CosmeticEntity, ModelStatus, TagSource, TagType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { styleTags, subjectTags } from '~/libs/tags';

const alwaysIncludeTags = [...styleTags, ...subjectTags];
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

    // Get the highest tier subscription for each user
    // Tier priority: founder > gold > silver > bronze > free
    const multipliers = await dbRead.$queryRaw<CachedUserMultiplier[]>`
      WITH ranked_subscriptions AS (
        SELECT
          cs."userId",
          cs.status,
          p.metadata,
          CASE (p.metadata->>'tier')::text
            WHEN 'gold' THEN 4
            WHEN 'silver' THEN 3
            WHEN 'bronze' THEN 2
            WHEN 'founder' THEN 2
            ELSE 1
          END as tier_rank,
          ROW_NUMBER() OVER (
            PARTITION BY cs."userId"
            ORDER BY
              CASE (p.metadata->>'tier')::text
                WHEN 'gold' THEN 4
                WHEN 'silver' THEN 3
                WHEN 'bronze' THEN 2
                WHEN 'founder' THEN 2
                ELSE 1
              END DESC
          ) as rn
        FROM "CustomerSubscription" cs
        JOIN "Product" p ON p.id = cs."productId"
        WHERE cs."userId" IN (${Prisma.join(ids)})
          AND cs.status NOT IN ('canceled')
      )
      SELECT
        u.id as "userId",
        CASE
          WHEN u."rewardsEligibility" = 'Ineligible'::"RewardsEligibility" THEN 0
          WHEN rs.status IS NULL OR rs.status NOT IN ('active', 'trialing') THEN 1
          ELSE COALESCE((rs.metadata->>'rewardsMultiplier')::float, 1)
        END as "rewardsMultiplier",
        CASE
          WHEN rs.status IS NULL OR rs.status NOT IN ('active', 'trialing') THEN 1
          ELSE COALESCE((rs.metadata->>'purchasesMultiplier')::float, 1)
        END as "purchasesMultiplier"
      FROM "User" u
      LEFT JOIN ranked_subscriptions rs ON u.id = rs."userId" AND rs.rn = 1
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

// Factory function to create user content counter caches
const createUserContentCountCache = <T extends Record<string, any>>(
  counterName: string,
  queryFn: (userIds: number[]) => Promise<T[]>
) => {
  return createCachedObject<T>({
    key: `${REDIS_KEYS.CACHES.OVERVIEW_USERS}:${counterName}`,
    idKey: 'id',
    ttl: CacheTTL.day,
    cacheNotFound: false,
    lookupFn: async (ids) => {
      const goodIds = ids.filter(isDefined);
      if (!goodIds.length) return {};

      const results = await queryFn(goodIds);
      return Object.fromEntries(results.map((x) => [x.id, x]));
    },
  });
};

// Individual cache objects for each user content counter
type UserModelCount = { id: number; modelCount: number };
export const userModelCountCache = createUserContentCountCache<UserModelCount>(
  'modelCount',
  async (userIds) => dbRead.$queryRaw`
    SELECT
      "userId" as id,
      COUNT(*)::INT as "modelCount"
    FROM "Model"
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "status" = 'Published'
      AND availability != 'Private'
    GROUP BY "userId"
  `
);

type UserPostCount = { id: number; postCount: number };
export const userPostCountCache = createUserContentCountCache<UserPostCount>(
  'postCount',
  async (userIds) => dbRead.$queryRaw`
    SELECT
      "userId" as id,
      COUNT(*)::INT as "postCount"
    FROM "Post"
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "publishedAt" IS NOT NULL
      AND "publishedAt" <= NOW()
      AND availability != 'Private'
    GROUP BY "userId"
  `
);

type UserImageVideoCount = { id: number; imageCount: number; videoCount: number };
export const userImageVideoCountCache = createUserContentCountCache<UserImageVideoCount>(
  'imageVideoCount',
  async (userIds) => dbRead.$queryRaw`
    SELECT
      "userId" as id,
      COALESCE(SUM(IIF("type" = 'image', 1, 0)), 0)::INT as "imageCount",
      COALESCE(SUM(IIF("type" = 'video', 1, 0)), 0)::INT as "videoCount"
    FROM "Image"
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "ingestion" = 'Scanned'
      AND "needsReview" IS NULL
      AND "postId" NOT IN (
        SELECT id
        FROM "Post"
        WHERE "userId" IN (${Prisma.join(userIds)})
          AND ("publishedAt" IS NULL OR availability = 'Private' OR "publishedAt" > NOW())
      )
    GROUP BY "userId"
  `
);

type UserArticleCount = { id: number; articleCount: number };
export const userArticleCountCache = createUserContentCountCache<UserArticleCount>(
  'articleCount',
  async (userIds) => dbRead.$queryRaw`
    SELECT
      "userId" as id,
      COUNT(*)::INT as "articleCount"
    FROM "Article"
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "publishedAt" IS NOT NULL
      AND "publishedAt" <= NOW()
      AND availability != 'Private'
      AND status = 'Published'::"ArticleStatus"
    GROUP BY "userId"
  `
);

type UserBountyCount = { id: number; bountyCount: number };
export const userBountyCountCache = createUserContentCountCache<UserBountyCount>(
  'bountyCount',
  async (userIds) => dbRead.$queryRaw`
    SELECT
      "userId" as id,
      COUNT(*)::INT as "bountyCount"
    FROM "Bounty"
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "startsAt" <= NOW()
      AND availability != 'Private'
    GROUP BY "userId"
  `
);

type UserBountyEntryCount = { id: number; bountyEntryCount: number };
export const userBountyEntryCountCache = createUserContentCountCache<UserBountyEntryCount>(
  'bountyEntryCount',
  async (userIds) => dbRead.$queryRaw`
    SELECT
      "userId" as id,
      COUNT(*)::INT as "bountyEntryCount"
    FROM "BountyEntry"
    WHERE "userId" IN (${Prisma.join(userIds)})
    GROUP BY "userId"
  `
);

type UserCollectionCount = { id: number; collectionCount: number };
export const userCollectionCountCache = createUserContentCountCache<UserCollectionCount>(
  'collectionCount',
  async (userIds) => dbRead.$queryRaw`
    SELECT
      "userId" as id,
      COUNT(*)::INT as "collectionCount"
    FROM "Collection"
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "read" = 'Public'
      AND availability != 'Private'
    GROUP BY "userId"
  `
);

type UserHasReceivedReviews = { id: number; hasReceivedReviews: boolean };
export const userHasReceivedReviewsCache = createUserContentCountCache<UserHasReceivedReviews>(
  'hasReceivedReviews',
  async (userIds) => dbRead.$queryRaw`
    SELECT DISTINCT
      m."userId" as id,
      true as "hasReceivedReviews"
    FROM "Model" m
    INNER JOIN "ResourceReview" r ON r."modelId" = m.id
    WHERE m."userId" IN (${Prisma.join(userIds)})
      AND r."userId" != m."userId"
  `
);

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

// Helper function to fetch all user content overview data using individual caches
export const getUserContentOverview = async (
  userIds: number | number[]
): Promise<Record<number, UserContentOverview>> => {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (!ids.length) return {};

  // Fetch all caches in parallel
  const [
    modelCounts,
    postCounts,
    imageVideoCounts,
    articleCounts,
    bountyCounts,
    bountyEntryCounts,
    collectionCounts,
    reviewFlags,
  ] = await Promise.all([
    userModelCountCache.fetch(ids),
    userPostCountCache.fetch(ids),
    userImageVideoCountCache.fetch(ids),
    userArticleCountCache.fetch(ids),
    userBountyCountCache.fetch(ids),
    userBountyEntryCountCache.fetch(ids),
    userCollectionCountCache.fetch(ids),
    userHasReceivedReviewsCache.fetch(ids),
  ]);

  // Merge results
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        id,
        modelCount: modelCounts[id]?.modelCount ?? 0,
        postCount: postCounts[id]?.postCount ?? 0,
        imageCount: imageVideoCounts[id]?.imageCount ?? 0,
        videoCount: imageVideoCounts[id]?.videoCount ?? 0,
        articleCount: articleCounts[id]?.articleCount ?? 0,
        bountyCount: bountyCounts[id]?.bountyCount ?? 0,
        bountyEntryCount: bountyEntryCounts[id]?.bountyEntryCount ?? 0,
        collectionCount: collectionCounts[id]?.collectionCount ?? 0,
        hasReceivedReviews: reviewFlags[id]?.hasReceivedReviews ?? false,
      },
    ])
  );
};

// Keep old cache object for backward compatibility
export const userContentOverviewCache = {
  fetch: getUserContentOverview,
  bust: async (userIds: number | number[]) => {
    // Bust all individual caches
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    await Promise.all([
      userModelCountCache.bust(ids),
      userPostCountCache.bust(ids),
      userImageVideoCountCache.bust(ids),
      userArticleCountCache.bust(ids),
      userBountyCountCache.bust(ids),
      userBountyEntryCountCache.bust(ids),
      userCollectionCountCache.bust(ids),
      userHasReceivedReviewsCache.bust(ids),
    ]);
  },
};

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

type ArticleStatLookup = {
  articleId: number;
  favoriteCount: number;
  collectedCount: number;
  commentCount: number;
  likeCount: number;
  dislikeCount: number;
  heartCount: number;
  laughCount: number;
  cryCount: number;
  viewCount: number;
  tippedAmountCount: number;
};

export const articleStatCache = createCachedObject<ArticleStatLookup>({
  key: REDIS_KEYS.CACHES.ARTICLE_STATS,
  idKey: 'articleId',
  ttl: CacheTTL.day,
  cacheNotFound: false,
  lookupFn: async (ids, fromWrite) => {
    const db = fromWrite ? dbWrite : dbRead;
    const articleIds = Array.isArray(ids) ? ids : [ids];
    if (articleIds.length === 0) return {};

    // Query ArticleMetric table directly for AllTime metrics
    const stats = await db.$queryRaw<ArticleStatLookup[]>`
      SELECT
        "articleId",
        "favoriteCount",
        "collectedCount",
        "commentCount",
        "likeCount",
        "dislikeCount",
        "heartCount",
        "laughCount",
        "cryCount",
        "viewCount",
        "tippedAmountCount"
      FROM "ArticleMetric"
      WHERE "articleId" IN (${Prisma.join(articleIds)})
        AND "timeframe" = 'AllTime'::"MetricTimeframe"
    `;

    return Object.fromEntries(stats.map((x) => [x.articleId, x]));
  },
});

type PostStatLookup = {
  postId: number;
  commentCount: number;
  likeCount: number;
  dislikeCount: number;
  heartCount: number;
  laughCount: number;
  cryCount: number;
  collectedCount: number;
};

export const postStatCache = createCachedObject<PostStatLookup>({
  key: REDIS_KEYS.CACHES.POST_STATS,
  idKey: 'postId',
  ttl: CacheTTL.day,
  lookupFn: async (ids, fromWrite) => {
    const db = fromWrite ? dbWrite : dbRead;
    const postIds = Array.isArray(ids) ? ids : [ids];
    if (postIds.length === 0) return {};

    // Query PostMetric table directly for AllTime metrics
    const stats = await db.$queryRaw<PostStatLookup[]>`
      SELECT
        "postId",
        "commentCount",
        "likeCount",
        "dislikeCount",
        "heartCount",
        "laughCount",
        "cryCount",
        "collectedCount"
      FROM "PostMetric"
      WHERE "postId" IN (${Prisma.join(postIds)})
        AND "timeframe" = 'AllTime'::"MetricTimeframe"
    `;

    return Object.fromEntries(stats.map((x) => [x.postId, x]));
  },
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
export type ImageResourceCacheItem = {
  imageId: number;
  modelVersionId: number;
  strength: number | null;
  detected: boolean;
  modelId: number;
  modelName: string;
  modelType: string;
  versionName: string;
  baseModel: BaseModel;
  poi: boolean;
  minor: boolean;
};

type ImageResourcesCacheItem = {
  imageId: number;
  resources: ImageResourceCacheItem[];
};

export const imageResourcesCache = createCachedObject<ImageResourcesCacheItem>({
  key: REDIS_KEYS.CACHES.IMAGE_RESOURCES,
  idKey: 'imageId',
  ttl: CacheTTL.sm,
  lookupFn: async (ids) => {
    const imageIds = Array.isArray(ids) ? ids : [ids];
    if (imageIds.length === 0) return {};

    const resources = await dbRead.$queryRaw<ImageResourceCacheItem[]>`
      SELECT
        ir."imageId",
        ir."modelVersionId",
        ir.strength,
        ir.detected,
        m.id as "modelId",
        m.name as "modelName",
        m.type as "modelType",
        mv.name as "versionName",
        mv."baseModel",
        m.poi,
        m.minor
      FROM "ImageResourceNew" ir
      JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE ir."imageId" IN (${Prisma.join(imageIds)})
    `;

    // Group resources by imageId
    const grouped = resources.reduce((acc, resource) => {
      const { imageId } = resource;
      acc[imageId] ??= { imageId, resources: [] };
      acc[imageId].resources.push(resource);
      return acc;
    }, {} as Record<number, ImageResourcesCacheItem>);

    return grouped;
  },
});

/** Helper to get the baseModel for an image (from checkpoint resources) */
export function getBaseModelFromResources(
  resources: ImageResourceCacheItem[] | undefined
): BaseModel | null {
  if (!resources) return null;
  const checkpoint = resources.find((r) => r.modelType === 'Checkpoint');
  return checkpoint?.baseModel ?? null;
}

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

type UserDownloadItem = {
  modelVersionId: number;
  lastDownloaded: number; // timestamp in ms
};

type UserDownloadsCacheItem = {
  userId: number;
  downloads: UserDownloadItem[];
};

export const userDownloadsCache = createCachedObject<UserDownloadsCacheItem>({
  key: REDIS_KEYS.CACHES.USER_DOWNLOADS,
  idKey: 'userId',
  ttl: CacheTTL.hour,
  cacheNotFound: false,
  lookupFn: async (userIds) => {
    if (!clickhouse) return {};
    if (userIds.length === 0) return {};

    const results = await clickhouse.$query<{
      userId: number;
      modelVersionId: number;
      lastDownloaded: string;
    }>`
      SELECT
        userId,
        modelVersionId,
        max(lastDownloaded) as lastDownloaded
      FROM userModelDownloads
      WHERE userId IN (${userIds.join(',')})
      GROUP BY userId, modelVersionId
    `;

    // Group by userId
    const grouped = results.reduce((acc, { userId, modelVersionId, lastDownloaded }) => {
      acc[userId] ??= { userId, downloads: [] };
      acc[userId].downloads.push({
        modelVersionId,
        // ClickHouse returns dates as strings without timezone - append 'Z' to parse as UTC
        lastDownloaded: new Date(lastDownloaded.replace(' ', 'T') + 'Z').getTime(),
      });
      return acc;
    }, {} as Record<number, UserDownloadsCacheItem>);

    return grouped;
  },
});
