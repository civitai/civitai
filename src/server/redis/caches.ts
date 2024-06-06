import {
  Availability,
  CosmeticEntity,
  CosmeticSource,
  CosmeticType,
  ModelStatus,
  Prisma,
} from '@prisma/client';
import { BaseModel, BaseModelType, CacheTTL } from '~/server/common/constants';
import { dbWrite, dbRead } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import {
  GenerationResourceSelect,
  generationResourceSelect,
} from '~/server/selectors/generation.selector';
import { ProfileImage } from '~/server/selectors/image.selector';
import { ModelFileModel, modelFileSelect } from '~/server/selectors/modelFile.selector';
import {
  getImagesForModelVersion,
  getTagIdsForImages,
  ImagesForModelVersions,
} from '~/server/services/image.service';
import { reduceToBasicFileMetadata } from '~/server/services/model-file.service';
import { CachedObject, createCachedArray, createCachedObject } from '~/server/utils/cache-helpers';

export const tagIdsForImagesCache = createCachedObject<{ imageId: number; tags: number[] }>({
  key: REDIS_KEYS.CACHES.TAG_IDS_FOR_IMAGES,
  idKey: 'imageId',
  ttl: CacheTTL.day,
  async lookupFn(imageId, fromWrite) {
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
  ttl: 60 * 60 * 24, // 24 hours
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
  ttl: 60 * 60 * 24, // 24 hours
});

type CacheFilesForModelVersions = {
  modelVersionId: number;
  files: ModelFileModel[];
};
export const filesForModelVersionCache = createCachedObject<CacheFilesForModelVersions>({
  key: REDIS_KEYS.CACHES.FILES_FOR_MODEL_VERSION,
  idKey: 'modelVersionId',
  ttl: CacheTTL.sm,
  async lookupFn(ids) {
    let files = await dbRead.modelFile.findMany({
      where: { modelVersionId: { in: ids } },
      select: modelFileSelect,
    });
    files =
      files?.map(({ metadata, ...file }) => {
        return {
          ...file,
          metadata: reduceToBasicFileMetadata(metadata),
        };
      }) ?? [];

    const records: Record<number, CacheFilesForModelVersions> = {};
    for (const file of files) {
      if (!records[file.modelVersionId])
        records[file.modelVersionId] = { modelVersionId: file.modelVersionId, files: [] };
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
    const imageIds = [...records].flatMap((x) => x.images.map((i) => i.id));
    const tagIdsVar = await getTagIdsForImages(imageIds);
    for (const entry of records) {
      for (const image of entry.images) {
        image.tags = tagIdsVar?.[image.id]?.tags;
      }
    }
  },
});

export const cosmeticEntityCaches = Object.fromEntries(
  Object.values(CosmeticEntity).map((entity) => [
    entity as CosmeticEntity,
    createCachedObject<WithClaimKey<ContentDecorationCosmetic>>({
      key: `${REDIS_KEYS.CACHES.COSMETICS}:${entity}`,
      idKey: 'equippedToId',
      cacheNotFound: false,
      lookupFn: async (ids) => {
        const entityCosmetics = await dbRead.$queryRaw<WithClaimKey<ContentDecorationCosmetic>[]>`
          SELECT c.id, c.data, uc."equippedToId", uc."claimKey"
          FROM "UserCosmetic" uc
          JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
          WHERE uc."equippedToId" IN (${Prisma.join(ids as number[])})
            AND uc."equippedToType" = '${Prisma.raw(entity)}'::"CosmeticEntity"
            AND c.type = 'ContentDecoration';
        `;
        return Object.fromEntries(entityCosmetics.map((x) => [x.equippedToId, x]));
      },
      ttl: 60 * 60 * 24, // 24 hours
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
        cs."userId",
        COALESCE((p.metadata->>'rewardsMultiplier')::float, 1) as "rewardsMultiplier",
        COALESCE((p.metadata->>'purchasesMultiplier')::float, 1) as "purchasesMultiplier"
      FROM "CustomerSubscription" cs
      JOIN "Product" p ON p.id = cs."productId"
      WHERE cs."userId" IN (${Prisma.join(ids)})
        AND cs."status" IN ('active', 'trialing');
    `;

    const records: Record<number, CachedUserMultiplier> = Object.fromEntries(
      multipliers.map((m) => [m.userId, m])
    );
    for (const userId of ids) {
      if (records[userId]) continue;
      records[userId] = { userId, rewardsMultiplier: 1, purchasesMultiplier: 1 };
    }

    return records;
  },
});

export const resourceDataCache = createCachedArray<GenerationResourceSelect>({
  key: REDIS_KEYS.GENERATION.RESOURCE_DATA,
  idKey: 'id',
  lookupFn: async (ids) => {
    const dbResults = await dbRead.modelVersion.findMany({
      where: { id: { in: ids as number[] } },
      select: generationResourceSelect,
    });

    const results = dbResults.reduce((acc, result) => {
      acc[result.id] = result;
      return acc;
    }, {} as Record<string, GenerationResourceSelect>);
    return results;
  },
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
  lookupFn: async (ids) => {
    const versions = await dbRead.$queryRaw<(ModelVersionDetails & { modelId: number })[]>`
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

    const hashes = await dbRead.$queryRaw<{ modelId: number; hash: string }[]>`
      SELECT "modelId", hash
      FROM "ModelHash"
      WHERE
        "modelId" IN (${Prisma.join(ids)})
        AND "hashType" = 'SHA256'
        AND "fileType" IN ('Model', 'Pruned Model');
    `;

    const tags = await dbRead.$queryRaw<{ modelId: number; tagId: number; name: string }[]>`
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
