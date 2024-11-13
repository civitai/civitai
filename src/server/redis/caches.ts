import {
  Availability,
  CollectionReadConfiguration,
  CosmeticEntity,
  CosmeticSource,
  CosmeticType,
  ModelStatus,
  Prisma,
  TagSource,
  TagType,
} from '@prisma/client';
import dayjs from 'dayjs';
import { BaseModel, BaseModelType, CacheTTL, constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { generationResourceSelect } from '~/server/selectors/generation.selector';
import { ProfileImage } from '~/server/selectors/image.selector';
import { ModelFileModel, modelFileSelect } from '~/server/selectors/modelFile.selector';
import type { EntityAccessDataType } from '~/server/services/common.service';
import { getImagesForModelVersion, ImagesForModelVersions } from '~/server/services/image.service';
import { reduceToBasicFileMetadata } from '~/server/services/model-file.service';
import { CachedObject, createCachedArray, createCachedObject } from '~/server/utils/cache-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { removeEmpty } from '~/utils/object-helpers';
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

    const imageTags = await db.tagsOnImage.findMany({
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
    cosmetic: {
      id: number;
      name: string;
      type: CosmeticType;
      data: Prisma.JsonValue;
      source: CosmeticSource;
    };
    data: Prisma.JsonValue;
  }[];
};
export const userCosmeticCache = createCachedObject<UserCosmeticLookup>({
  key: REDIS_KEYS.CACHES.COSMETICS,
  idKey: 'userId',
  lookupFn: async (ids) => {
    const userCosmeticsRaw = await dbRead.userCosmetic.findMany({
      where: { userId: { in: ids }, equippedAt: { not: null }, equippedToId: null },
      select: {
        userId: true,
        data: true,
        cosmetic: { select: { id: true, data: true, type: true, source: true, name: true } },
      },
    });
    const results = userCosmeticsRaw.reduce((acc, { userId, ...cosmetic }) => {
      acc[userId] ??= { userId, cosmetics: [] };
      acc[userId].cosmetics.push(cosmetic);
      return acc;
    }, {} as Record<number, UserCosmeticLookup>);
    return results;
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

type CacheFilesForModelVersions = { files: ModelFileModel[] };
export const filesForModelVersionCache = createCachedObject<CacheFilesForModelVersions>({
  key: REDIS_KEYS.CACHES.FILES_FOR_MODEL_VERSION,
  ttl: CacheTTL.sm,
  async lookupFn(ids) {
    const files = (
      await dbRead.modelFile.findMany({
        where: { modelVersionId: { in: ids } },
        select: modelFileSelect,
      })
    ).map(({ metadata, ...file }) => {
      return {
        ...file,
        metadata: reduceToBasicFileMetadata(metadata),
      } as ModelFileModel;
    });

    const records: Record<number, CacheFilesForModelVersions> = {};
    for (const file of files) {
      if (!records[file.modelVersionId]) records[file.modelVersionId] = { files: [] };
      records[file.modelVersionId].files.push(file);
    }
    return records;
  },
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
    const keys = Object.keys(records).map(Number);
    const imageIds = keys.flatMap((x) => records[x].images.map((i) => i.id));
    const tagIdsVar = await tagIdsForImagesCache.fetch(imageIds);

    for (const key of keys) {
      records[key] = {
        ...records[key],
        images: records[key].images.map((image) => ({
          ...image,
          tags: tagIdsVar?.[image.id]?.tags ?? [],
        })),
      };
    }
  },
});

export const cosmeticEntityCaches = Object.fromEntries(
  Object.values(CosmeticEntity).map((entity) => [
    entity as CosmeticEntity,
    createCachedObject<WithClaimKey<ContentDecorationCosmetic>>({
      key: `${REDIS_KEYS.CACHES.COSMETICS}:${entity}`,
      // idKey: 'equippedToId',
      cacheNotFound: false,
      lookupFn: async (ids) => {
        // TODO: This might be a gamble since dbWrite could be heavily hit, however, considering we have
        // 1 day TTL, it might be worth it to keep the cache fresh. With dbRead, lag can cause cosmetics to linger
        // for 1 day.
        const entityCosmetics = await dbWrite.$queryRaw<WithClaimKey<ContentDecorationCosmetic>[]>`
          SELECT c.id, c.data, uc."equippedToId", uc."claimKey"
          FROM "UserCosmetic" uc
          JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
          WHERE uc."equippedToId" IN (${Prisma.join(ids as number[])})
            AND uc."equippedToType" = '${Prisma.raw(entity)}'::"CosmeticEntity"
            AND c.type = 'ContentDecoration';
        `;
        return Object.fromEntries(entityCosmetics.map((x) => [x.equippedToId, x]));
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

type ModelVersionAccessCache = EntityAccessDataType & { publishedAt: Date };

export const modelVersionAccessCache = createCachedObject<ModelVersionAccessCache>({
  key: REDIS_KEYS.CACHES.ENTITY_AVAILABILITY.MODEL_VERSIONS,
  idKey: 'entityId',
  ttl: CacheTTL.day,
  dontCacheFn: (data) => {
    // We only wanna cache public models. Otherwise, we better confirm every time. It's a safer bet.
    // Also, only cache it if it's been published for more than an hour.
    const oneHourAgo = dayjs().subtract(1, 'hour').toDate();
    const isOlderThanOneHour = data.publishedAt < oneHourAgo;

    return data.availability !== 'Public' || !isOlderThanOneHour || !data.publishedAt;
  },
  lookupFn: async (ids) => {
    const goodIds = ids.filter(isDefined);
    if (!goodIds.length) return {};
    const entityAccessData = await dbRead.$queryRaw<ModelVersionAccessCache[]>(Prisma.sql`
      SELECT
        mv.id AS "entityId",
        mmv."userId" AS "userId",
        mv."availability" AS "availability",
        mv."publishedAt" AS "publishedAt"
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

export type ResourceData = AsyncReturnType<typeof resourceDataCache.fetch>[number];
export const resourceDataCache = createCachedArray({
  key: REDIS_KEYS.GENERATION.RESOURCE_DATA,
  lookupFn: async (ids) => {
    const [modelVersions, modelVersionFiles] = await Promise.all([
      dbWrite.modelVersion.findMany({
        where: { id: { in: ids as number[] } },
        select: generationResourceSelect,
      }),
      dbRead.modelFile.findMany({
        where: { modelVersionId: { in: ids }, visibility: 'Public' },
        select: { id: true, sizeKB: true, type: true, metadata: true, modelVersionId: true },
      }),
    ]);

    const dbResults = modelVersions.map(({ generationCoverage, settings = {}, ...result }) => {
      const covered = generationCoverage?.covered ?? false;
      const files = modelVersionFiles.filter((x) => x.modelVersionId === result.id) as {
        id: number;
        sizeKB: number;
        type: string;
        modelVersionId: number;
        metadata: FileMetadata;
      }[];
      const primaryFile = getPrimaryFile(files);
      const available =
        covered && ['Public', 'EarlyAccess', 'Private'].includes(result.availability);

      return removeEmpty({
        ...result,
        settings: settings as RecommendedSettingsSchema,
        covered,
        fileSizeKB: primaryFile?.sizeKB ? Math.round(primaryFile.sizeKB) : undefined,
        available,
      });
    });

    const results = dbResults.reduce<Record<number, (typeof dbResults)[number]>>((acc, result) => {
      acc[result.id] = result;
      return acc;
    }, {});
    return results;
  },
  idKey: 'id',
  dontCacheFn: (data) => !data.available,
  ttl: CacheTTL.hour,
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
