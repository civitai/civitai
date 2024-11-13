import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CheckResourcesCoverageSchema,
  GenerationStatus,
  generationStatusSchema,
  GetGenerationDataInput,
  GetGenerationResourcesInput,
} from '~/server/schema/generation.schema';
import { SessionUser } from 'next-auth';
import { dbRead } from '~/server/db/client';
import {
  handleLogError,
  throwAuthorizationError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ModelType, Prisma } from '@prisma/client';

import { isDefined } from '~/utils/type-guards';

import { imageGenerationSchema } from '~/server/schema/image.schema';
import { uniqBy } from 'lodash-es';
import { redis, REDIS_KEYS } from '~/server/redis/client';

import { fromJson, toJson } from '~/utils/json-helpers';

import { getPagedData } from '~/server/utils/pagination-helpers';
import { modelsSearchIndex } from '~/server/search-index';

import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { filesForModelVersionCache, resourceDataCache } from '~/server/redis/caches';
import {
  formatGenerationResources,
  GenerationResource,
  getBaseModelFromResources,
  getBaseModelSet,
} from '~/shared/constants/generation.constants';
import { findClosest } from '~/utils/number-helpers';
import {
  TextToImageParams,
  TextToImageStepRemixMetadata,
} from '~/server/schema/orchestrator/textToImage.schema';
import { getGenerationConfig } from '~/server/common/constants';
import { cleanPrompt } from '~/utils/metadata/audit';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getFeaturedModels } from '~/server/services/model.service';

export function parseModelVersionId(assetId: string) {
  const pattern = /^@civitai\/(\d+)$/;
  const match = assetId.match(pattern);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

// const baseModelSetsArray = Object.values(baseModelSets);
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
  remixOfId?: number;
  // runType: 'run' | 'remix' | ''
};

export const getGenerationData = async (props: GetGenerationDataInput): Promise<GenerationData> => {
  switch (props.type) {
    case 'image':
      return await getImageGenerationData(props.id);
    case 'modelVersion':
      return await getResourceGenerationData([props.id]);
    case 'modelVersions':
      return await getResourceGenerationData(props.ids);
    default:
      throw new Error('unsupported generation data type');
  }
};

async function getCachedResourceGenerationData(modelVersionIds: number[]) {
  if (!modelVersionIds.length) throw new Error('missing modelVersionIds');
  return await resourceDataCache.fetch(modelVersionIds);
  /*
    Not sure if we'll end up using this or not. Leaving it here in case we need to pull model file information with generation resources
  */
  // const [resources, files] = await Promise.all([
  //   resourceDataCache.fetch(modelVersionIds),
  //   filesForModelVersionCache.fetch(modelVersionIds),
  // ]);
  // const resourcesWithFiles = resources
  //   .map((resource) => {
  //     const resourceFiles = files[resource.id]?.files;
  //     if (!resourceFiles) return null;
  //     const file = getPrimaryFile(resourceFiles);
  //     if (!file) return null;
  //     return {
  //       modelId: resource.model.id,
  //       modelType: resource.model.type,
  //       fileSizeKB: file.sizeKB,
  //     };
  //   })
  //   .filter(isDefined);
  // const additionalCharges = await getShouldChargeForResources(resourcesWithFiles);

  // return resources.map((resource) => {
  //   const additionalCharge = additionalCharges[resource.model.id];
  //   return { ...resource, additionalCharge };
  // });
}

async function getResourceGenerationData(versionIds: number[]) {
  if (!versionIds.length) throw new Error('missing version ids');
  const ids = [...new Set(versionIds)];
  const resources = await getCachedResourceGenerationData(ids);
  const checkpoint = resources.find((x) => x.baseModel === 'Checkpoint');
  if (checkpoint?.vaeId) {
    const [vae] = await getCachedResourceGenerationData([checkpoint.vaeId]);
    if (vae) resources.push({ ...vae, vaeId: null });
  }

  const formatted = formatGenerationResources(resources);

  return {
    resources: formatted,
    params: {
      baseModel: getBaseModelFromResources(formatted),
      clipSkip: resources.length === 1 ? resources[0].clipSkip ?? undefined : undefined,
    },
  };
}

// const defaultCheckpointData: Partial<Record<BaseModelSetType, ResourceData>> = {};
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
  const resourceData = await getCachedResourceGenerationData(versionIds);

  const index = resourceData.findIndex((x) => x.model.type === 'Checkpoint');
  if (index > -1 && !resourceData[index].available) {
    const checkpoint = resourceData[index];
    const latestVersion = await dbRead.modelVersion.findFirst({
      where: {
        modelId: checkpoint.model.id,
        availability: { in: ['Public', 'EarlyAccess'] },
        generationCoverage: { covered: true },
      },
      select: { id: true },
      orderBy: { index: 'asc' },
    });
    if (latestVersion) {
      const [newCheckpoint] = await getCachedResourceGenerationData([latestVersion.id]);
      if (newCheckpoint) resourceData[index] = newCheckpoint;
    }
  }

  const resources = formatGenerationResources(resourceData);

  // dedupe resources and add image resource strength/hashes
  const deduped = uniqBy(resources, 'id').map((resource) => {
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

  const baseModel = getBaseModelFromResources(deduped);

  // Clean-up bad values
  if (meta.cfgScale == 0) meta.cfgScale = 7;
  if (meta.steps == 0) meta.steps = 30;
  if (meta.seed == 0) meta.seed = undefined;

  let aspectRatio = '0';
  try {
    if (image.width && image.height) {
      const config = getGenerationConfig(baseModel);
      const ratios = config.aspectRatios.map((x) => x.width / x.height);
      const closest = findClosest(ratios, image.width / image.height);
      aspectRatio = `${ratios.indexOf(closest)}`;
    }
  } catch (e) {}

  const { prompt, negativePrompt } = cleanPrompt(meta);

  return {
    // only send back resources if we have a checkpoint resource
    resources: deduped,
    params: {
      ...meta,
      clipSkip,
      aspectRatio,
      baseModel,
      prompt,
      negativePrompt,
    },
    remixOfId: image.id,
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

const FREE_RESOURCE_TYPES: ModelType[] = ['VAE', 'Checkpoint'];
export async function getShouldChargeForResources(
  args: {
    modelType: ModelType;
    modelId: number;
    fileSizeKB: number;
  }[]
) {
  const featuredModels = await getFeaturedModels();
  return args.reduce<Record<string, boolean>>(
    (acc, { modelType, modelId, fileSizeKB }) => ({
      ...acc,
      [modelId]:
        !FREE_RESOURCE_TYPES.includes(modelType) &&
        !featuredModels.includes(modelId) &&
        fileSizeKB > 10 * 1024,
    }),
    {}
  );
}
