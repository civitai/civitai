import { Prisma } from '@prisma/client';
import { uniqBy } from 'lodash-es';
import type { SessionUser } from 'next-auth';
import { EntityAccessPermission, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import {
  getWanVersion,
  wan21BaseModelMap,
  wanGeneralBaseModelMap,
} from '~/server/orchestrator/wan/wan.schema';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  CheckResourcesCoverageSchema,
  GenerationStatus,
  GetGenerationDataSchema,
  GetGenerationResourcesInput,
} from '~/server/schema/generation.schema';
import { generationStatusSchema } from '~/server/schema/generation.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { modelsSearchIndex } from '~/server/search-index';
import { hasEntityAccess } from '~/server/services/common.service';
import type { ModelFileCached } from '~/server/services/model-file.service';
import { getFilesForModelVersionCache } from '~/server/services/model-file.service';
import type { GenerationResourceDataModel } from '~/server/redis/resource-data.redis';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import { getFeaturedModels } from '~/server/services/model.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPrimaryFile, getTrainingFileEpochNumberDetails } from '~/server/utils/model-helpers';
import { getPagedData } from '~/server/utils/pagination-helpers';
import {
  fluxKreaAir,
  fluxUltraAir,
  getBaseModelFromResources,
  getBaseModelFromResourcesWithDefault,
  getBaseModelSetType,
  ponyV7Air,
} from '~/shared/constants/generation.constants';
import type { MediaType, ModelType } from '~/shared/utils/prisma/enums';
import type { GenerationResource } from '~/shared/types/generation.types';

import { fromJson, toJson } from '~/utils/json-helpers';
import { removeNulls } from '~/utils/object-helpers';
import { parseAIR, stringifyAIR } from '~/shared/utils/air';
import { isDefined } from '~/utils/type-guards';
import { getVeo3ProcessFromAir } from '~/server/orchestrator/veo3/veo3.schema';
import type { BaseModelGroup } from '~/shared/constants/base-model.constants';
import {
  getBaseModelEngine,
  getBaseModelMediaType,
  getBaseModelsByGroup,
  getGenerationBaseModelGroup,
} from '~/shared/constants/base-model.constants';
import { getMetaResources, normalizeMeta } from '~/server/services/normalize-meta.service';
import { mapDataToGraphInput } from '~/server/services/orchestrator/legacy-metadata-mapper';

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
  sfwOnly: boolean;
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
        const baseModels = getBaseModelsByGroup(baseModel as BaseModelGroup);
        if (baseModels.length)
          sqlAnd.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModels, ',')})`);
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
          orderBy.startsWith('mm') ? `JOIN "ModelMetric" mm ON mm."modelId" = m.id` : ''
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
  createdAt: Date;
};
/**
 * Generation data returned from the API.
 * Uses flat resources array + params format for storage compatibility.
 * Clients should use splitResourcesByType() to route resources to graph nodes.
 */
export type GenerationData = {
  type: MediaType;
  remixOfId?: number;
  remixOf?: RemixOfProps;
  /** Flat array of all resources (checkpoint, LoRAs, VAE, etc.) */
  resources: GenerationResource[];
  /** Generation parameters (prompt, seed, steps, etc.) */
  params: Record<string, unknown>;
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
        versionIds: [{ id: query.id, epoch: query.epoch }],
        user,
        generation: query.generation,
      });
    case 'modelVersions':
      return await getModelVersionGenerationData({
        user,
        versionIds: query.ids,
        generation: query.generation,
      });
    default:
      throw new Error('unsupported generation data type');
  }
};

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
      createdAt: true,
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
    createdAt: media.createdAt,
  };

  // const { resources: imageResources, ...meta } = normalizeMeta(media.meta as ImageMetaProps);
  const initialMeta = media.meta as ImageMetaProps;
  const imageResources = getMetaResources(initialMeta);

  await dbRead.imageResourceNew
    .findMany({
      where: { imageId: id },
      select: { modelVersionId: true, strength: true },
    })
    .then((res) => {
      for (const { modelVersionId, strength } of res) {
        const exists = imageResources.some((x) => x.modelVersionId === modelVersionId);
        if (!exists)
          imageResources.push({
            modelVersionId,
            strength: strength ? strength / 100 : undefined,
          });
      }
    });
  const versionIds = [...new Set(imageResources.map((x) => x.modelVersionId).filter(isDefined))];
  const allResources = await getResourceData(versionIds, user, generation).then((data) =>
    data.map((item) => {
      const imageResource = imageResources.find((x) => x.modelVersionId === item.id);
      return {
        ...item,
        strength: imageResource?.strength ?? item.strength,
      };
    })
  );
  const baseModel = getBaseModelFromResources(
    allResources.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
  );

  const type = baseModel ? getBaseModelMediaType(baseModel) ?? media.type : media.type;
  const engine = initialMeta.engine ?? (baseModel ? getBaseModelEngine(baseModel) : undefined);
  const normalized = normalizeMeta({ ...initialMeta, baseModel, engine });
  const supportedResources = normalized.baseModel
    ? getGenerationBaseModelGroup(normalized.baseModel)
    : undefined;
  const resources = !supportedResources
    ? allResources
    : allResources.filter((x) =>
        supportedResources.supportMap.get(x.model.type)?.some((m) => m.baseModel === x.baseModel)
      );

  // Delegate param mapping to shared function (handles workflow, baseModel, aspectRatio, etc.)
  // Cast to Record for loose field access (normalizeMeta returns a union type)
  const meta = normalized as Record<string, unknown>;
  // Handle legacy 'Clip skip' field name (old image meta uses space-separated key)
  const clipSkip = meta.clipSkip ?? meta['Clip skip'] ?? undefined;
  const params = mapDataToGraphInput({ ...meta, width, height, clipSkip, engine }, resources);

  if (type === 'audio') throw new Error('not implemented');

  // Return flat resources array - clients use splitResourcesByType() to route to graph nodes
  return {
    type,
    remixOfId: media.id, // TODO - remove
    remixOf,
    resources,
    params,
  };
}

const getModelVersionGenerationData = async ({
  versionIds,
  user,
  generation,
}: {
  versionIds: { id: number; epoch?: number }[] | number[];
  user?: SessionUser;
  generation: boolean;
}): Promise<GenerationData> => {
  if (!versionIds.length) throw new Error('missing version ids');
  const resources = await getResourceData(versionIds, user, generation);
  const checkpoint = resources.find((x) => x.model.type === 'Checkpoint');
  if (checkpoint?.vaeId) {
    const [vae] = await getResourceData([checkpoint.vaeId], user, generation);
    if (vae) resources.push({ ...vae, vaeId: undefined });
  }

  const deduped = uniqBy(resources, 'id');

  // Build params from checkpoint settings
  const params = mapDataToGraphInput(
    {
      clipSkip: checkpoint?.clipSkip,
    },
    deduped
  );

  // Return flat resources array - clients use splitResourcesByType() to route to graph nodes
  return {
    type: getBaseModelMediaType(params.baseModel as string),
    resources: deduped,
    params,
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
          !featuredModels.map((fm) => fm.modelId).includes(modelId) &&
          fileSizeKB > 10 * 1024
        : false,
    }),
    {}
  );
}

const explicitCoveredModelAirs = [fluxUltraAir, ponyV7Air];
const explicitCoveredModelVersionIds = explicitCoveredModelAirs.map((air) => parseAIR(air).version);

export async function getResourceData(
  versionIds: { id: number; epoch?: number }[] | number[],
  user: { id?: number; isModerator?: boolean } = {},
  generation = false
): Promise<(GenerationResource & { air: string })[]> {
  if (!versionIds.length) return [];
  const args = (
    typeof versionIds[0] === 'number' ? versionIds.map((id) => ({ id })) : versionIds
  ) as { id: number; epoch?: number }[];

  const unavailableResources = await getUnavailableResources();
  const featuredModels = await getFeaturedModels();

  function transformGenerationData(
    { settings, ...item }: GenerationResourceDataModel,
    epochNumber?: number
  ) {
    const isUnavailable = unavailableResources.includes(item.id);

    const isOwnedByUser = !!user.id && user.id === item.model.userId;
    const hasAccess = !!(item.hasAccess || isOwnedByUser || user.isModerator);
    const covered =
      (item.covered || explicitCoveredModelVersionIds.includes(item.id)) && !isUnavailable;

    // Valid statuses for generation: Draft (training epochs), Training, Published
    // Other statuses (Deleted, Unpublished, etc.) cannot be used for generation
    const validGenerationStatuses = ['Draft', 'Training', 'Published'];
    const hasValidStatus = validGenerationStatuses.includes(item.status);

    // Resource is private if:
    // 1. Availability is explicitly Private, OR
    // 2. Status is Draft or Training (unpublished/training epochs)
    const isPrivate =
      item.availability === 'Private' || ['Draft', 'Training'].includes(item.status);

    // canGenerate is the definitive "can this user use this resource" flag
    // Requires: covered by orchestrator AND valid status AND (not private OR user owns it)
    const canGenerate = covered && hasValidStatus && (!isPrivate || isOwnedByUser);

    if (!canGenerate) {
      // Delete these items so that the client doesn't have to notify users about these props. They are irrelevant if the resource cannot be used for generation.
      delete item.model.sfwOnly;
      delete item.model.minor;
    }

    return {
      ...item,
      minStrength: settings?.minStrength ?? -1,
      maxStrength: settings?.maxStrength ?? 2,
      strength: settings?.strength ?? 1,
      hasAccess,
      canGenerate,
      epochNumber,
      isOwnedByUser,
      isPrivate,
    };
  }

  async function getResourceDataSubstitutes(
    resources: ReturnType<typeof transformGenerationData>[]
  ) {
    const modelIdsThatRequireSubstitutes = resources
      .filter((x) => !x.covered || !x.hasAccess)
      .map((x) => x.model.id);

    const substituteIds = await dbRead.modelVersion
      .findMany({
        where: {
          status: 'Published',
          generationCoverage: { covered: true },
          modelId: { in: modelIdsThatRequireSubstitutes },
        },
        orderBy: { index: { sort: 'asc', nulls: 'last' } },
        select: { id: true, baseModel: true, modelId: true },
      })
      .then((data) =>
        data
          .filter((x) => {
            const match = resources.find((resource) => resource.model.id === x.modelId);
            return match?.baseModel === x.baseModel;
          })
          .map((x) => x.id)
      );

    return await resourceDataCache
      .fetch(substituteIds)
      .then((data) => data.map((item) => transformGenerationData(item)));
  }

  async function getEntityAccess(resources: ReturnType<typeof transformGenerationData>[]) {
    const earlyAccessIds = resources
      .filter(
        (x) =>
          x.covered &&
          !x.hasAccess &&
          x.earlyAccessConfig &&
          // Free generation will technically bypass access checks, but we still want to show the early access badge
          !x.earlyAccessConfig.freeGeneration
      )
      .map((x) => x.id);

    return user.id
      ? await hasEntityAccess({
          entityType: 'ModelVersion',
          entityIds: earlyAccessIds,
          userId: user.id,
          isModerator: user.isModerator,
          permissions: EntityAccessPermission.EarlyAccessGeneration,
        })
      : [];
  }

  async function getModelFiles(resources: ReturnType<typeof transformGenerationData>[]) {
    const versionIds = resources.filter((x) => x.hasAccess).map((x) => x.id);
    return await getFilesForModelVersionCache(versionIds);
  }

  function getEpochDetails(
    resource: ReturnType<typeof transformGenerationData>,
    modelFiles: ModelFileCached[]
  ) {
    if (resource.status !== 'Published') {
      const trainingFile = modelFiles.find((f) => f.type === 'Training Data');
      if (trainingFile) {
        const details = getTrainingFileEpochNumberDetails(trainingFile, resource.epochNumber);
        if (!details?.isExpired) {
          return details;
        }
      }
    }
    delete resource.epochNumber;

    return null;
  }

  function getModelFileProps(
    resource: ReturnType<typeof transformGenerationData>,
    modelFiles: ModelFileCached[]
  ) {
    const primaryFile = getPrimaryFile(modelFiles);
    const fileSizeKB = primaryFile?.sizeKB;
    const featured = !!featuredModels.find((x) => x.modelId === resource.model.id);
    let additionalResourceCost = true;
    if (
      featured ||
      FREE_RESOURCE_TYPES.includes(resource.model.type) ||
      (fileSizeKB && fileSizeKB <= 10 * 1024)
    ) {
      additionalResourceCost = false;
    }

    const epochDetails = getEpochDetails(resource, modelFiles);

    return {
      fileSizeKB: fileSizeKB ? Math.round(fileSizeKB) : undefined,
      additionalResourceCost,
      epochDetails,
    };
  }

  function bringItAllTogether(
    resource: ReturnType<typeof transformGenerationData>,
    modelFiles: ModelFileCached[]
  ) {
    const { fileSizeKB, additionalResourceCost, epochDetails } = getModelFileProps(
      resource,
      modelFiles
    );
    const air = stringifyAIR({
      baseModel: resource.baseModel,
      type: resource.model.type,
      modelId: epochDetails ? epochDetails.jobId : resource.model.id,
      id: epochDetails ? epochDetails.fileName : resource.id,
      source: epochDetails ? 'orchestrator' : 'civitai',
    });

    return { ...resource, fileSizeKB, additionalResourceCost, epochDetails, air };
  }

  function getSubstituteData(
    resource: ReturnType<typeof transformGenerationData>,
    substitutes: ReturnType<typeof transformGenerationData>[],
    modelFiles: ModelFileCached[]
  ) {
    const substitute = substitutes.find((x) => x.hasAccess && x.model.id === resource.model.id);
    if (substitute) {
      const { model, ...rest } = bringItAllTogether(substitute, modelFiles);
      return removeNulls({ ...rest, ...getModelFileProps(substitute, modelFiles) });
    }
  }

  // Expand cache results to produce one entry per unique (id, epoch) pair.
  // The cache deduplicates by model version ID, but different epochs of the same
  // model version need separate entries with their own epochDetails.
  const uniqueIds = [...new Set(args.map((x) => x.id))];
  const resources = await resourceDataCache
    .fetch(uniqueIds)
    .then((cachedResources) => {
      const resourceById = new Map(cachedResources.map((r) => [r.id, r]));
      return args
        .map((arg) => {
          const cached = resourceById.get(arg.id);
          if (!cached) return null;
          return transformGenerationData(cached, arg.epoch);
        })
        .filter(isDefined);
    })
    .then(async (resources) => {
      const substitutes = await getResourceDataSubstitutes(resources);
      const entityAccess = await getEntityAccess([...resources, ...substitutes]);

      for (const resource of [...resources, ...substitutes]) {
        if (!resource.hasAccess) {
          // TODO - get the number of remaining early access downloads if early access allows limited number of free generations
          resource.hasAccess = !!(
            entityAccess.find((e) => e.entityId === resource.id)?.hasAccess ||
            !!resource.earlyAccessConfig?.generationTrialLimit
          );
          resource.canGenerate = resource.hasAccess && resource.canGenerate;
        }
      }

      const modelFilesCached = await getModelFiles([...resources, ...substitutes]);

      return resources.map((resource) => {
        const modelFiles = modelFilesCached[resource.id]?.files ?? [];
        const substitute = getSubstituteData(resource, substitutes, modelFiles);
        return removeNulls({ ...bringItAllTogether(resource, modelFiles), substitute });
      });
    });

  // TODO - check if resource id is in "EcosystemCheckpoint" table
  return generation
    ? resources.filter((resource) => {
        const baseModel = getBaseModelSetType(resource.baseModel);
        const size = getGenerationBaseModelGroup(baseModel)?.supportMap.size;
        return !!size;
      })
    : resources;
}
