import { GetByIdInput } from '~/server/schema/base.schema';
import {
  BulkDeleteGeneratedImagesInput,
  CheckResourcesCoverageSchema,
  CreateGenerationRequestInput,
  GenerationRequestTestRunSchema,
  GenerationStatus,
  generationStatusSchema,
  GetGenerationDataInput,
  GetGenerationRequestsOutput,
  GetGenerationResourcesInput,
  PrepareModelInput,
} from '~/server/schema/generation.schema';
import { SessionUser } from 'next-auth';
import { dbRead } from '~/server/db/client';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ModelType, Prisma } from '@prisma/client';

import { isDefined } from '~/utils/type-guards';

import {
  BaseModel,
  baseModelSets,
  BaseModelSetType,
  getGenerationConfig,
  Sampler,
} from '~/server/common/constants';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import { uniqBy } from 'lodash-es';
import orchestratorCaller from '~/server/http/orchestrator/orchestrator.caller';
import { redis, REDIS_KEYS } from '~/server/redis/client';

import { fromJson, toJson } from '~/utils/json-helpers';

import { getPagedData } from '~/server/utils/pagination-helpers';
import { modelsSearchIndex } from '~/server/search-index';

import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { UserTier } from '~/server/schema/user.schema';
import { generatorFeedbackReward } from '~/server/rewards';
import { ResourceData, resourceDataCache } from '~/server/redis/caches';
import {
  defaultCheckpoints,
  formatGenerationResources,
  GenerationResource,
  getBaseModelSet,
  getBaseModelSetType,
} from '~/shared/constants/generation.constants';
import { findClosest } from '~/utils/number-helpers';
import {
  TextToImageParams,
  TextToImageStepRemixMetadata,
} from '~/server/schema/orchestrator/textToImage.schema';
import dayjs from 'dayjs';

export function parseModelVersionId(assetId: string) {
  const pattern = /^@civitai\/(\d+)$/;
  const match = assetId.match(pattern);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

const baseModelSetsArray = Object.values(baseModelSets);
/** @deprecated using search index instead... */
export const getGenerationResources = async (
  input: GetGenerationResourcesInput & { user?: SessionUser }
) => {
  return await getPagedData<GetGenerationResourcesInput, GenerationResource[]>(
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
        if (baseModelSet.length)
          sqlAnd.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModelSet, ',')})`);
      }

      let orderBy = 'mv.index';
      if (!query) orderBy = `mm."thumbsUpCount", ${orderBy}`;

      const results = await dbRead.$queryRaw<Array<GenerationResource & { index: number }>>`
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

// const baseModelToOrchestration: Record<BaseModelSetType, string | undefined> = {
//   SD1: 'SD_1_5',
//   SD2: undefined,
//   SD3: 'SD_3',
//   SDXL: 'SDXL',
//   SDXLDistilled: 'SDXL_Distilled',
//   SCascade: 'SCascade',
//   Pony: 'SDXL',
//   Lumina: 'Lumina',
//   HyDit1: 'HyDit1',
//   PixArtA: 'PixArtA',
//   PixArtE: 'PixArtE',
//   ODOR: undefined,
// };

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
    JSON.parse((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, REDIS_KEYS.GENERATION.STATUS)) ?? '{}')
  );

  return status as GenerationStatus;
}

export type GenerationData = {
  resources: GenerationResource[];
  params: Partial<TextToImageParams>;
  remix?: TextToImageStepRemixMetadata;
};

export const getGenerationData = async (props: GetGenerationDataInput): Promise<GenerationData> => {
  switch (props.type) {
    case 'image':
      return await getImageGenerationData(props.id);
    case 'modelVersion':
      return await getResourceGenerationData({ modelVersionId: props.id });
    case 'modelVersions':
      return await getMultipleResourceGenerationData({ versionIds: props.ids });
    default:
      throw new Error('unsupported generation data type');
  }
};

export const getResourceGenerationData = async ({ modelVersionId }: { modelVersionId: number }) => {
  if (!modelVersionId) throw new Error('modelVersionId required');
  const resources = await resourceDataCache.fetch([modelVersionId]);
  if (!resources.length) throw throwNotFoundError();

  const [resource] = resources;
  if (resource.vaeId) {
    const [vae] = await resourceDataCache.fetch([resource.vaeId]);
    if (vae) resources.push({ ...vae, vaeId: null });
  }
  const baseModel = getBaseModelSetType(resource.baseModel);
  return {
    resources: uniqBy(formatGenerationResources(resources), 'id'),
    params: {
      baseModel,
      clipSkip: resource.clipSkip ?? undefined,
    },
    remix: {
      versionId: resource.id,
    },
  };
};

const getMultipleResourceGenerationData = async ({ versionIds }: { versionIds: number[] }) => {
  if (!versionIds.length) throw new Error('missing version ids');
  const resources = await resourceDataCache.fetch(versionIds);
  const checkpoint = resources.find((x) => x.baseModel === 'Checkpoint');
  if (checkpoint?.vaeId) {
    const [vae] = await resourceDataCache.fetch([checkpoint.vaeId]);
    if (vae) resources.push({ ...vae, vaeId: null });
  }
  return {
    resources: uniqBy(formatGenerationResources(resources), 'id'),
    params: {},
  };
};

const defaultCheckpointData: Partial<Record<BaseModelSetType, ResourceData>> = {};
const getImageGenerationData = async (id: number) => {
  const [image, imageResources] = await dbRead.$transaction([
    dbRead.image.findUnique({
      where: { id },
      select: {
        id: true,
        meta: true,
        height: true,
        width: true,
      },
    }),
    dbRead.imageResource.findMany({
      where: { imageId: id },
      select: { imageId: true, modelVersionId: true, hash: true, strength: true },
    }),
  ]);
  if (!image) throw throwNotFoundError();

  const {
    'Clip skip': legacyClipSkip,
    clipSkip = legacyClipSkip,
    comfy, // don't return to client
    external, // don't return to client
    ...meta
  } = imageGenerationSchema.parse(image.meta);

  const versionIds = imageResources.map((x) => x.modelVersionId).filter(isDefined);
  const resourceData = await resourceDataCache.fetch(versionIds);
  const resources = formatGenerationResources(resourceData);

  // if the checkpoint exists but isn't covered, add a default based off checkpoint `modelType`
  let checkpoint = resources.find((x) => x.modelType === 'Checkpoint');
  if (!checkpoint?.covered && checkpoint?.modelType) {
    const baseModel = getBaseModelSetType(checkpoint.baseModel);
    const defaultCheckpoint = baseModel ? defaultCheckpoints[baseModel] : undefined;
    if (baseModel && defaultCheckpoint) {
      // fetch default base model data
      if (!defaultCheckpointData[baseModel]) {
        const [resource] = await resourceDataCache.fetch([defaultCheckpoint.version]);
        if (resource) {
          defaultCheckpointData[baseModel] = { ...resource, covered: true };
        }
      }

      // add default base model data to front of resources
      const defaultBaseModel = defaultCheckpointData[baseModel];
      if (defaultBaseModel) {
        const [formattedResource] = formatGenerationResources([defaultBaseModel]);
        resources.unshift(formattedResource);
      }
    }
  }

  // dedupe resources and add image resource strength/hashes
  const deduped = uniqBy(resources, 'id')
    .filter((x) => x.covered)
    .map((resource) => {
      const imageResource = imageResources.find((x) => x.modelVersionId === resource.id);
      return {
        ...resource,
        strength: imageResource?.strength ? imageResource.strength / 100 : 1,
        hash: imageResource?.hash ?? undefined,
      };
    });

  if (meta.hashes && meta.prompt) {
    for (const [key, hash] of Object.entries(meta.hashes)) {
      if (!['lora:', 'lyco:'].some((x) => key.startsWith(x))) continue;

      // get the resource that matches the hash
      const uHash = hash.toUpperCase();
      const resource = deduped.find((x) => x.hash === uHash);
      if (!resource || resource.strength) continue;

      // get everything that matches <key:{number}>
      const matches = new RegExp(`<${key}:([0-9\.]+)>`, 'i').exec(meta.prompt);
      if (!matches) continue;

      resource.strength = parseFloat(matches[1]);
    }
  }

  checkpoint = deduped.find((x) => x.modelType === 'Checkpoint');
  const baseModel = getBaseModelSetType(checkpoint?.baseModel);

  // Clean-up bad values
  if (meta.cfgScale == 0) meta.cfgScale = 7;
  if (meta.steps == 0) meta.steps = 30;
  if (meta.seed == 0) meta.seed = undefined;

  let aspectRatio = '0';
  if (image.width && image.height) {
    const config = getGenerationConfig(baseModel);
    const ratios = config.aspectRatios.map((x) => x.width / x.height);
    const closest = findClosest(ratios, image.width / image.height);
    aspectRatio = `${ratios.indexOf(closest)}`;
  }

  return {
    // only send back resources if we have a checkpoint resource
    resources: checkpoint ? deduped : [],
    params: {
      ...meta,
      clipSkip,
      aspectRatio,
      baseModel,
    },
    remix: {
      imageId: image.id,
    },
  };
};

export async function getUnstableResources() {
  const cachedData = await redis
    .hGet(REDIS_KEYS.SYSTEM.FEATURES, 'generation:unstable-resources')
    .then((data) => (data ? fromJson<number[]>(data) : ([] as number[])))
    .catch(() => [] as number[]); // fallback to empty array if redis fails

  return cachedData ?? [];
}

export async function getUnavailableResources() {
  const cachedData = await redis
    .hGet(REDIS_KEYS.SYSTEM.FEATURES, 'generation:unavailable-resources')
    .then((data) => (data ? fromJson<number[]>(data) : ([] as number[])))
    .catch(() => [] as number[]); // fallback to empty array if redis fails

  return [...new Set(cachedData)] ?? [];
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

  await redis.hSet(
    REDIS_KEYS.SYSTEM.FEATURES,
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
