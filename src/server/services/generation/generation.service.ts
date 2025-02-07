import { Prisma } from '@prisma/client';
import { uniqBy } from 'lodash-es';
import type { SessionUser } from 'next-auth';
import { getGenerationConfig } from '~/server/common/constants';

import { EntityAccessPermission, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CheckResourcesCoverageSchema,
  GenerationStatus,
  generationStatusSchema,
  GetGenerationDataSchema,
  GetGenerationResourcesInput,
} from '~/server/schema/generation.schema';

import { imageGenerationSchema } from '~/server/schema/image.schema';
import { ModelVersionEarlyAccessConfig } from '~/server/schema/model-version.schema';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import { modelsSearchIndex } from '~/server/search-index';
import { hasEntityAccess } from '~/server/services/common.service';
import { getFilesForModelVersionCache } from '~/server/services/model-file.service';
import {
  GenerationResourceDataModel,
  resourceDataCache,
} from '~/server/services/model-version.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { MediaType, ModelType } from '~/shared/utils/prisma/enums';

import { fromJson, toJson } from '~/utils/json-helpers';

import { getPagedData } from '~/server/utils/pagination-helpers';
import {
  baseModelResourceTypes,
  fluxUltraAir,
  getBaseModelFromResources,
  getBaseModelSet,
  getBaseModelSetType,
  SupportedBaseModel,
} from '~/shared/constants/generation.constants';
import { isFutureDate } from '~/utils/date-helpers';
import { cleanPrompt } from '~/utils/metadata/audit';
import { findClosest } from '~/utils/number-helpers';
import { removeNulls } from '~/utils/object-helpers';
import { parseAIR } from '~/utils/string-helpers';
import { getFeaturedModels } from '~/server/services/model.service';
import { isDefined } from '~/utils/type-guards';
import { env } from '~/env/server';

type GenerationResourceSimple = {
  id: number;
  name: string;
  trainedWords: string[];
  modelId: number;
  modelName: string;
  modelType: ModelType;
  baseModel: string;
  strength: number;
  minStrength: number;
  maxStrength: number;
  minor: boolean;
  fileSizeKB: number;
  available: boolean;
};

// const baseModelSetsArray = Object.values(baseModelSets);
/** @deprecated using search index instead... */
export const getGenerationResources = async (
  input: GetGenerationResourcesInput & { user?: SessionUser }
) => {
  return await getPagedData<GetGenerationResourcesInput, GenerationResourceSimple[]>(
    input,
    async ({
      take,
      skip,
      query,
      types,
      notTypes,
      ids, // used for getting initial values of resources
      baseModel,
      supported,
    }) => {
      const preselectedVersions: number[] = [];
      if ((!ids || ids.length === 0) && !query) {
        const featuredCollection = await dbRead.collection
          .findFirst({
            where: { userId: -1, name: 'Generator' },
            select: {
              items: {
                select: {
                  model: {
                    select: {
                      name: true,
                      type: true,
                      modelVersions: {
                        select: { id: true, name: true },
                        where: { status: 'Published' },
                        orderBy: { index: 'asc' },
                        take: 1,
                      },
                    },
                  },
                },
              },
            },
          })
          .catch(() => null);

        if (featuredCollection)
          preselectedVersions.push(
            ...featuredCollection.items.flatMap(
              (x) => x.model?.modelVersions.map((x) => x.id) ?? []
            )
          );

        ids = preselectedVersions;
      }

      const sqlAnd = [Prisma.sql`mv.status = 'Published' AND m.status = 'Published'`];
      if (ids && ids.length > 0) sqlAnd.push(Prisma.sql`mv.id IN (${Prisma.join(ids, ',')})`);
      if (!!types?.length)
        sqlAnd.push(Prisma.sql`m.type = ANY(ARRAY[${Prisma.join(types, ',')}]::"ModelType"[])`);
      if (!!notTypes?.length)
        sqlAnd.push(Prisma.sql`m.type != ANY(ARRAY[${Prisma.join(notTypes, ',')}]::"ModelType"[])`);
      if (query) {
        const pgQuery = '%' + query + '%';
        sqlAnd.push(Prisma.sql`m.name ILIKE ${pgQuery}`);
      }
      if (baseModel) {
        // const baseModelSet = baseModelSetsArray.find((x) => x.includes(baseModel as BaseModel));
        const baseModelSet = getBaseModelSet(baseModel);
        if (baseModelSet.baseModels.length)
          sqlAnd.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModelSet.baseModels, ',')})`);
      }

      let orderBy = 'mv.index';
      if (!query) orderBy = `mm."thumbsUpCount", ${orderBy}`;

      const results = await dbRead.$queryRaw<Array<GenerationResourceSimple & { index: number }>>`
        SELECT
          mv.id,
          mv.index,
          mv.name,
          mv."trainedWords",
          m.id "modelId",
          m.name "modelName",
          m.type "modelType",
          mv."baseModel",
          mv.settings->>'strength' strength,
          mv.settings->>'minStrength' "minStrength",
          mv.settings->>'maxStrength' "maxStrength"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        ${Prisma.raw(
          supported
            ? `JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id AND gc.covered = true`
            : ''
        )}
        ${Prisma.raw(
          orderBy.startsWith('mm')
            ? `JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = 'AllTime'`
            : ''
        )}
        WHERE ${Prisma.join(sqlAnd, ' AND ')}
        ORDER BY ${Prisma.raw(orderBy)}
        LIMIT ${take}
        OFFSET ${skip}
      `;
      const rowCount = await dbRead.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        ${Prisma.raw(
          supported
            ? `JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id AND gc.covered = true`
            : ''
        )}
        WHERE ${Prisma.join(sqlAnd, ' AND ')}
      `;
      const [{ count }] = rowCount;

      return {
        items: results.map((resource) => ({
          ...resource,
          strength: 1,
        })),
        count,
      };
    }
  );
};

export async function checkResourcesCoverage({ id }: CheckResourcesCoverageSchema) {
  const unavailableGenResources = await getUnavailableResources();
  const result = await dbRead.generationCoverage.findFirst({
    where: { modelVersionId: id },
    select: { covered: true },
  });

  return (result?.covered ?? false) && unavailableGenResources.indexOf(id) === -1;
}

export async function getGenerationStatus() {
  const status = generationStatusSchema.parse(
    JSON.parse(
      (await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.GENERATION.STATUS)) ??
        '{}'
    )
  );

  return status as GenerationStatus;
}

export type RemixOfProps = {
  id?: number;
  url?: string;
  type: MediaType;
  similarity?: number;
};
export type GenerationData = {
  remixOfId?: number;
  resources: GenerationResource[];
  params: Partial<TextToImageParams>;
  remixOf?: RemixOfProps;
};

export const getGenerationData = async ({
  query,
  user,
}: {
  query: GetGenerationDataSchema;
  user?: SessionUser;
}): Promise<GenerationData> => {
  switch (query.type) {
    case 'image':
    case 'video':
      return await getMediaGenerationData({ id: query.id, user, generation: query.generation });
    case 'modelVersion':
      return await getModelVersionGenerationData({
        versionIds: [query.id],
        user,
        generation: query.generation,
      });
    case 'modelVersions':
      return await getModelVersionGenerationData({
        versionIds: query.ids,
        user,
        generation: query.generation,
      });
    default:
      throw new Error('unsupported generation data type');
  }
};

type ResourceType = 'generation' | 'all';
async function getMediaGenerationData({
  id,
  user,
  generation,
}: {
  id: number;
  user?: SessionUser;
  generation: boolean;
}): Promise<GenerationData> {
  const media = await dbRead.image.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      url: true,
      meta: true,
      height: true,
      width: true,
    },
  });
  if (!media) throw throwNotFoundError();

  const width = media.width ? media.width : 0;
  const height = media.height ? media.height : 0;
  const remixOf: RemixOfProps = {
    id: media.id,
    type: media.type,
    url: media.url,
    similarity: 1,
  };

  const { prompt, negativePrompt } = cleanPrompt(media.meta as Record<string, any>);
  const common = {
    prompt,
    negativePrompt,
  };

  switch (media.type) {
    case 'image':
      const imageResources = await dbRead.imageResource.findMany({
        where: { imageId: id },
        select: { imageId: true, modelVersionId: true, hash: true, strength: true },
      });
      const versionIds = [
        ...new Set(imageResources.map((x) => x.modelVersionId).filter(isDefined)),
      ];
      const fn = generation ? getGenerationResourceData : getResourceData;
      const resources = await fn({ ids: versionIds, user }).then((data) =>
        data.map((item) => {
          const imageResource = imageResources.find((x) => x.modelVersionId === item.id);
          return {
            ...item,
            hash: imageResource?.hash ?? undefined,
            strength: imageResource?.strength ? imageResource.strength / 100 : item.strength,
          };
        })
      );
      const baseModel = getBaseModelFromResources(
        resources.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
      );

      let aspectRatio = '0';
      try {
        if (width && height) {
          const config = getGenerationConfig(baseModel);
          const ratios = config.aspectRatios.map((x) => x.width / x.height);
          const closest = findClosest(ratios, width / height);
          aspectRatio = `${ratios.indexOf(closest)}`;
        }
      } catch (e) {}

      const {
        'Clip skip': legacyClipSkip,
        clipSkip = legacyClipSkip,
        comfy, // don't return to client
        external, // don't return to client
        ...meta
      } = imageGenerationSchema.parse(media.meta);

      if (meta.hashes && meta.prompt) {
        for (const [key, hash] of Object.entries(meta.hashes)) {
          if (!['lora:', 'lyco:'].some((x) => key.startsWith(x))) continue;

          // get the resource that matches the hash
          const uHash = hash.toUpperCase();
          const resource = resources.find((x) => x.hash === uHash);
          if (!resource || resource.strength) continue;

          // get everything that matches <key:{number}>
          const matches = new RegExp(`<${key}:([0-9\.]+)>`, 'i').exec(meta.prompt);
          if (!matches) continue;

          resource.strength = parseFloat(matches[1]);
        }
      }

      return {
        remixOfId: media.id, // TODO - remove
        remixOf,
        resources,
        params: {
          ...common,
          cfgScale: meta.cfgScale !== 0 ? meta.cfgScale : undefined,
          steps: meta.steps !== 0 ? meta.steps : undefined,
          seed: meta.seed !== 0 ? meta.seed : undefined,
          width,
          height,
          aspectRatio,
          baseModel,
          clipSkip,
        },
      };
    case 'video':
      return {
        remixOfId: media.id, // TODO - remove,
        remixOf,
        resources: [] as GenerationResource[],
        params: {
          ...(media.meta as Record<string, any>),
          ...common,
          width,
          height,
        },
      };
    case 'audio':
      throw new Error('not implemented');
  }
}

const getModelVersionGenerationData = async ({
  versionIds,
  user,
  generation,
}: {
  versionIds: number[];
  user?: SessionUser;
  generation: boolean;
}) => {
  if (!versionIds.length) throw new Error('missing version ids');
  const fn = generation ? getGenerationResourceData : getResourceData;
  const resources = await fn({ ids: versionIds, user });
  const checkpoint = resources.find((x) => x.baseModel === 'Checkpoint');
  if (checkpoint?.vaeId) {
    const [vae] = await fn({ ids: [checkpoint.vaeId], user });
    if (vae) resources.push({ ...vae, vaeId: undefined });
  }

  const deduped = uniqBy(resources, 'id');

  return {
    resources: deduped,
    params: {
      baseModel: getBaseModelFromResources(
        deduped.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
      ),
      clipSkip: checkpoint?.clipSkip ?? undefined,
    },
  };
};

export async function getUnstableResources() {
  const cachedData = await sysRedis
    .hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:unstable-resources')
    .then((data) => (data ? fromJson<number[]>(data) : ([] as number[])))
    .catch(() => [] as number[]); // fallback to empty array if redis fails

  return cachedData ?? [];
}

export async function getUnavailableResources() {
  const cachedData = await sysRedis
    .hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:unavailable-resources')
    .then((data) => (data ? fromJson<number[]>(data) : ([] as number[])))
    .catch(() => [] as number[]); // fallback to empty array if redis fails

  return [...new Set(cachedData ?? [])];
}

export async function toggleUnavailableResource({
  id,
  isModerator,
}: GetByIdInput & { isModerator?: boolean }) {
  if (!isModerator) throw throwAuthorizationError();

  const unavailableResources = await getUnavailableResources();
  const index = unavailableResources.indexOf(id);
  if (index > -1) unavailableResources.splice(index, 1);
  else unavailableResources.push(id);

  await sysRedis.hSet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    'generation:unavailable-resources',
    toJson(unavailableResources)
  );

  const modelVersion = await dbRead.modelVersion.findUnique({
    where: { id },
    select: { modelId: true },
  });
  if (modelVersion)
    modelsSearchIndex
      .queueUpdate([
        {
          id: modelVersion.modelId,
          action: SearchIndexUpdateQueueAction.Update,
        },
      ])
      .catch(handleLogError);

  return unavailableResources;
}

const FREE_RESOURCE_TYPES: ModelType[] = ['VAE', 'Checkpoint'];
export async function getShouldChargeForResources(
  args: {
    modelType: ModelType;
    modelId: number;
    fileSizeKB?: number;
  }[]
) {
  const featuredModels = await getFeaturedModels();
  return args.reduce<Record<string, boolean>>(
    (acc, { modelType, modelId, fileSizeKB }) => ({
      ...acc,
      [modelId]: fileSizeKB
        ? !FREE_RESOURCE_TYPES.includes(modelType) &&
          !featuredModels.includes(modelId) &&
          fileSizeKB > 10 * 1024
        : false,
    }),
    {}
  );
}

type GenerationResourceBase = {
  id: number;
  name: string;
  trainedWords: string[];
  vaeId?: number;
  baseModel: string;
  earlyAccessEndsAt?: Date;
  earlyAccessConfig?: ModelVersionEarlyAccessConfig;
  canGenerate: boolean;
  hasAccess: boolean;
  covered: boolean;
  additionalResourceCost?: boolean;
  // settings
  clipSkip?: number;
  minStrength: number;
  maxStrength: number;
  strength: number;
};

export type GenerationResource = GenerationResourceBase & {
  model: {
    id: number;
    name: string;
    type: ModelType;
    nsfw?: boolean;
    poi?: boolean;
    minor?: boolean;
    // userId: number;
  };
  substitute?: GenerationResourceBase;
};

const explicitCoveredModelAirs = [fluxUltraAir];
const explicitCoveredModelVersionIds = explicitCoveredModelAirs.map((air) => parseAIR(air).version);
export async function getResourceData({
  ids,
  user,
}: {
  ids: number[];
  user?: {
    id?: number;
    isModerator?: boolean;
  };
}): Promise<GenerationResource[]> {
  if (!ids.length) return [];
  const { id: userId, isModerator } = user ?? {};
  const unavailableResources = await getUnavailableResources();
  const featuredModels = await getFeaturedModels();

  function transformGenerationData({ settings, ...item }: GenerationResourceDataModel) {
    const isUnavailable = unavailableResources.includes(item.model.id);

    return {
      ...item,
      minStrength: settings?.minStrength ?? -1,
      maxStrength: settings?.maxStrength ?? 2,
      strength: settings?.strength ?? 1,
      covered: (item.covered || explicitCoveredModelVersionIds.includes(item.id)) && !isUnavailable,
      hasAccess: !!(
        ['Public', 'Unsearchable'].includes(item.availability) ||
        userId === item.model.userId ||
        isModerator
      ),
    };
  }
  return await resourceDataCache.fetch(ids).then(async (initialResult) => {
    const initialTransformed = initialResult.map(transformGenerationData);
    const modelIds = initialTransformed
      .filter((x) => !x.covered || !x.hasAccess)
      .map((x) => x.model.id);
    const substituteIds = await dbRead.modelVersion
      .findMany({
        where: {
          status: 'Published',
          generationCoverage: { covered: true },
          modelId: { in: modelIds },
        },
        orderBy: { index: { sort: 'asc', nulls: 'last' } },
        select: { id: true, baseModel: true, modelId: true },
      })
      .then((data) =>
        data
          .filter((x) => {
            const match = initialTransformed.find((initial) => initial.model.id === x.modelId);
            if (!match) return false;
            return match.baseModel === x.baseModel;
          })
          .map((x) => x.id)
      );

    const substitutesTransformed = await resourceDataCache
      .fetch(substituteIds)
      .then((data) => data.map(transformGenerationData));

    const earlyAccessIds = [...initialTransformed, ...substitutesTransformed]
      .filter(
        (x) =>
          x.covered &&
          !x.hasAccess &&
          x.availability === 'EarlyAccess' &&
          x.earlyAccessEndsAt &&
          isFutureDate(x.earlyAccessEndsAt)
      )
      .map((x) => x.id);

    const entityAccessArray = userId
      ? await hasEntityAccess({
          entityType: 'ModelVersion',
          entityIds: earlyAccessIds,
          userId,
          isModerator,
          permissions: EntityAccessPermission.EarlyAccessGeneration,
        })
      : [];

    const [initialWithAccess, substitutesWithAccess] = [
      initialTransformed,
      substitutesTransformed,
    ].map((tupleItem) =>
      tupleItem.map((item) => {
        return {
          ...item,
          earlyAccessConfig:
            item.availability === 'EarlyAccess' && item.earlyAccessConfig
              ? Object.keys(item.earlyAccessConfig).length
                ? item.earlyAccessConfig
                : undefined
              : undefined,
          hasAccess: !!(
            (
              item.hasAccess ||
              entityAccessArray.find((e) => e.entityId === item.id)?.hasAccess ||
              !!item.earlyAccessConfig?.generationTrialLimit
            ) // TODO - get the number of remaining early access downloads if early access allows limited number of free generations
          ),
        };
      })
    );

    const modelFilesCached = await getFilesForModelVersionCache(
      [...initialWithAccess, ...substitutesWithAccess].filter((x) => x.hasAccess).map((x) => x.id)
    );

    return initialWithAccess.map(({ availability, ...item }) => {
      const primaryFile = getPrimaryFile(modelFilesCached[item.id]?.files ?? []);
      const substitute = substitutesWithAccess.find(
        (sub) => sub.model.id === item.model.id && sub.hasAccess
      );
      const fileSizeKB = primaryFile?.sizeKB;
      let additionalResourceCost = false;
      if (env.ORCHESTRATOR_EXPERIMENTAL && fileSizeKB) {
        additionalResourceCost =
          !FREE_RESOURCE_TYPES.includes(item.model.type) &&
          !featuredModels.includes(item.model.id) &&
          fileSizeKB > 10 * 1024;
      }

      const payload = removeNulls({
        ...item,
        canGenerate: item.covered && item.hasAccess,
        fileSizeKB: fileSizeKB ? Math.round(fileSizeKB) : undefined,
        additionalResourceCost,
      });

      if (substitute) {
        const { model, availability, ...sub } = substitute;
        return {
          ...payload,
          substitute: removeNulls({ ...sub, canGenerate: sub.covered && sub.hasAccess }),
        };
      }

      return payload;
    });
  });
}

export async function getGenerationResourceData(args: {
  ids: number[];
  user?: {
    id?: number;
    isModerator?: boolean;
  };
}) {
  return await getResourceData(args).then((data) =>
    data.filter((resource) => {
      const baseModel = getBaseModelSetType(resource.baseModel) as SupportedBaseModel;
      return !!baseModelResourceTypes[baseModel];
    })
  );
}
