import { Prisma } from '@prisma/client';
import {
  Availability,
  CollectionReadConfiguration,
  CosmeticEntity,
  CosmeticSource,
  CosmeticType,
  ModelStatus,
  TagSource,
  TagType,
} from '~/shared/utils/prisma/enums';
import dayjs from 'dayjs';
import { BaseModel, BaseModelType, CacheTTL, constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { ProfileImage } from '~/server/selectors/image.selector';
import type { EntityAccessDataType } from '~/server/services/common.service';
import { getImagesForModelVersion, ImagesForModelVersions } from '~/server/services/image.service';
import { CachedObject, createCachedObject } from '~/server/utils/cache-helpers';
import { isDefined } from '~/utils/type-guards';
import { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';

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

    const imageTags = await db.tagsOnImage.findMany({
      where: { imageId: { in: imageIds }, disabledAt: null },
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
        COALESCE((p.metadata->>'purchasesMultiplier')::float, 1) as "purchasesMultiplier"
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
      },
    });
    return Object.fromEntries(tagBasicData.map((x) => [x.id, x]));
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

    const tags = await db.$queryRaw<{ modelId: number; tagId: number; name: string }[]>`
      SELECT "modelId", "tagId", t."name"
      FROM "TagsOnModels"
      JOIN "Tag" t ON "tagId" = t."id"
      WHERE "modelId" IN (${Prisma.join(ids)})
      AND "tagId" IS NOT NULL;
    `;

    const results = versions.reduce((acc, { modelId, ...version }) => {
      acc[modelId] ??= { modelId, hashes: [], tags: [], versions: [] };
      acc[modelId].versions.push(version);
      return acc;
    }, {} as Record<number, ModelDataCache>);
    for (const { modelId, hash } of hashes) results[modelId]?.hashes.push(hash);
    for (const { modelId, ...tag } of tags) results[modelId]?.tags.push(tag);
    return results;
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
        (SELECT COUNT(*)::INT FROM "Image" i
          INNER JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" IS NOT NULL AND p.availability != 'Private'
          WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL AND i."userId" = u.id AND i."postId" IS NOT NULL AND i."type" = 'image'::"MediaType"
        ) as "imageCount",
        (SELECT COUNT(*)::INT FROM "Image" i
          INNER JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" IS NOT NULL AND p.availability != 'Private'
          WHERE i."ingestion" = 'Scanned' AND i."needsReview" IS NULL AND i."userId" = u.id AND i."postId" IS NOT NULL AND i."type" = 'video'::"MediaType"
        ) as "videoCount",
        (SELECT COUNT(*)::INT FROM "Article" a WHERE a."userId" = u.id AND a."publishedAt" IS NOT NULL AND a."publishedAt" <= NOW() AND a.availability != 'Private' AND a.status = 'Published'::"ArticleStatus") as "articleCount",
        (SELECT COUNT(*)::INT FROM "Bounty" b WHERE b."userId" = u.id AND b."startsAt" <= NOW() AND b.availability != 'Private') as "bountyCount",
        (SELECT COUNT(*)::INT FROM "BountyEntry" be WHERE be."userId" = u.id) as "bountyEntryCount",
        (SELECT EXISTS (SELECT 1 FROM "ResourceReview" r INNER JOIN "Model" m ON m.id = r."modelId" AND m."userId" = u.id WHERE r."userId" != u.id)) as "hasReceivedReviews",
        (SELECT COUNT(*)::INT FROM "Collection" c WHERE c."userId" = u.id AND c."read" = ${
          CollectionReadConfiguration.Public
        }::"CollectionReadConfiguration" AND c.availability != 'Private') as "collectionCount"
    FROM "User" u
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
