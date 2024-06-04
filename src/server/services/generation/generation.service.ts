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
  draftMode,
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
  getBaseModelSetType,
  samplersToSchedulers,
} from '~/shared/constants/generation.constants';
import { findClosest } from '~/utils/number-helpers';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import dayjs from 'dayjs';

export function parseModelVersionId(assetId: string) {
  const pattern = /^@civitai\/(\d+)$/;
  const match = assetId.match(pattern);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

// function mapRequestStatus(label: string): GenerationRequestStatus {
//   switch (label) {
//     case 'Pending':
//       return GenerationRequestStatus.Pending;
//     case 'Processing':
//       return GenerationRequestStatus.Processing;
//     case 'Cancelled':
//       return GenerationRequestStatus.Cancelled;
//     case 'Error':
//       return GenerationRequestStatus.Error;
//     case 'Succeeded':
//       return GenerationRequestStatus.Succeeded;
//     default:
//       throw new Error(`Invalid status label: ${label}`);
//   }
// }

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
        const baseModelSet = baseModelSetsArray.find((x) => x.includes(baseModel as BaseModel));
        if (baseModelSet)
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

// const formatGenerationRequests = async (requests: Generation.Api.RequestProps[]) => {
//   const modelVersionIds = requests
//     .map((x) => parseModelVersionId(x.job.model))
//     .concat(
//       requests.flatMap((x) => Object.keys(x.job.additionalNetworks ?? {}).map(parseModelVersionId))
//     )
//     .filter((x) => x !== null) as number[];

//   const modelVersions = await resourceDataCache.fetch(modelVersionIds);

//   const checkpoint = modelVersions.find((x) => x.model.type === 'Checkpoint');
//   const baseModel = getBaseModelSetType(checkpoint?.baseModel);

//   // const alternativesAvailable =
//   //   ((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, 'generation:alternatives')) ?? 'false') ===
//   //   'true';

//   return requests.map((x): Generation.Request => {
//     const { additionalNetworks = {}, params, ...job } = x.job;

//     let assets = [x.job.model, ...Object.keys(x.job.additionalNetworks ?? {})];

//     // scrub negative prompt
//     let negativePrompt = params.negativePrompt ?? '';
//     for (const { triggerWord, id } of allInjectedNegatives) {
//       negativePrompt = negativePrompt.replace(`${triggerWord}, `, '');
//       assets = assets.filter((x) => x !== `@civitai/${id}`);
//     }

//     let prompt = params.prompt ?? '';
//     for (const { triggerWord, id } of allInjectedPositives) {
//       prompt = prompt.replace(`${triggerWord}, `, '');
//       assets = assets.filter((x) => x !== `@civitai/${id}`);
//     }

//     const request = {
//       id: x.id,
//       // alternativesAvailable,
//       createdAt: x.createdAt,
//       // estimatedCompletionDate: x.estimatedCompletedAt,
//       status: mapRequestStatus(x.status),
//       // queuePosition: x.queuePosition,
//       cost: x.cost,
//       params: {
//         ...params,
//         prompt,
//         baseModel,
//         negativePrompt,
//         seed: params.seed === -1 ? undefined : params.seed,
//         sampler: Object.entries(samplersToSchedulers).find(
//           ([sampler, scheduler]) => scheduler === params.scheduler
//         )?.[0],
//       },
//       resources: assets
//         .map((assetId): Generation.Resource | undefined => {
//           const modelVersionId = parseModelVersionId(assetId);
//           const modelVersion = modelVersions.find((x) => x.id === modelVersionId);
//           const network = x.job.additionalNetworks?.[assetId] ?? {};
//           if (!modelVersion) return undefined;
//           const { model } = modelVersion;
//           return {
//             id: modelVersion.id,
//             name: modelVersion.name,
//             trainedWords: modelVersion.trainedWords,
//             modelId: model.id,
//             modelName: model.name,
//             modelType: model.type,
//             baseModel: modelVersion.baseModel,
//             ...network,
//           };
//         })
//         .filter(isDefined),
//       ...job,
//       images: x.images
//         ?.map(({ jobToken, ...image }) => image)
//         .sort((a, b) => (b.duration ?? 1) - (a.duration ?? 1)),
//     };

//     // if (alternativesAvailable) request.alternativesAvailable = true;

//     return request;
//   });
// };

// export type GetGenerationRequestsReturn = AsyncReturnType<typeof getGenerationRequests>;
// export const getGenerationRequests = async (
//   props: GetGenerationRequestsOutput & { userId: number }
// ) => {
//   const params = QS.stringify(props);
//   const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests?${params}`);
//   if (!response.ok) throw new Error(response.statusText);
//   const { cursor, requests }: Generation.Api.Request = await response.json();

//   const items = await formatGenerationRequests(requests);

//   return {
//     items: items.filter((x) => !!x.images?.length),
//     nextCursor: cursor === 0 ? undefined : cursor ?? undefined,
//   };
// };

const baseModelToOrchestration: Record<BaseModelSetType, string | undefined> = {
  SD1: 'SD_1_5',
  SD2: undefined,
  SD3: 'SD_3',
  SDXL: 'SDXL',
  SDXLDistilled: 'SDXL_Distilled',
  SCascade: 'SCascade',
  Pony: 'SDXL',
  ODOR: undefined,
};

// async function checkResourcesAccess(
//   resources: CreateGenerationRequestInput['resources'],
//   userId: number
// ) {
//   const data = await getResourceData(resources.map((x) => x.id));
//   const hasPrivateResources = data.some((x) => x.availability === Availability.Private);

//   if (hasPrivateResources) {
//     // Check for permission:
//     const entityAccess = await hasEntityAccess({
//       entityIds: data.map((d) => d.id),
//       entityType: 'ModelVersion',
//       userId,
//     });

//     return entityAccess.every((a) => a.hasAccess);
//   }

//   return true;
// }

const getDraftStateFromInputForOrchestrator = ({
  baseModel,
  quantity,
  steps,
  cfgScale,
  sampler,
}: {
  baseModel?: string;
  quantity: number;
  steps: number;
  cfgScale: number;
  sampler: string;
}) => {
  // Fix other params
  const isSDXL = baseModel === 'SDXL' || baseModel === 'Pony';
  const draftModeSettings = draftMode[isSDXL ? 'sdxl' : 'sd1'];

  if (quantity % 4 !== 0) quantity = Math.ceil(quantity / 4) * 4;
  steps = draftModeSettings.steps;
  cfgScale = draftModeSettings.cfgScale;
  sampler = draftModeSettings.sampler;
  const resourceId = draftModeSettings.resourceId;

  return { quantity, steps, cfgScale, sampler, resourceId };
};

// export const createGenerationRequest = async ({
//   userId,
//   userTier,
//   isModerator,
//   resources,
//   params: { nsfw, negativePrompt, draft, ...params },
// }: CreateGenerationRequestInput & {
//   userId: number;
//   userTier?: UserTier;
//   isModerator?: boolean;
// }) => {
//   if (resources.length === 0) throw throwBadRequestError('No resources provided');

//   // Handle generator disabled
//   const status = await getGenerationStatus();
//   if (!status.available && !isModerator)
//     throw throwBadRequestError('Generation is currently disabled');

//   // Handle the request limits
//   const limits = status.limits[userTier ?? 'free'];
//   if (params.quantity > limits.quantity) params.quantity = limits.quantity;
//   if (params.steps > limits.steps) params.steps = limits.steps;
//   // +1 for the checkpoint
//   if (resources.length > limits.resources + 1)
//     throw throwBadRequestError('You have exceeded the resources limit.');

//   // This is disabled for now, because it performs so poorly...
//   // const requests = await getGenerationRequests({
//   //   userId,
//   //   status: [GenerationRequestStatus.Pending, GenerationRequestStatus.Processing],
//   //   take: limits.queue + 1,
//   // });
//   // if (requests.items.length >= limits.queue)
//   //   throw throwRateLimitError(
//   //     'You have too many pending generation requests. Try again when some are completed.'
//   //   );

//   // Handle Draft Mode
//   const isSDXL =
//     params.baseModel === 'SDXL' ||
//     params.baseModel === 'Pony' ||
//     params.baseModel === 'SDXLDistilled';
//   const draftModeSettings = draftMode[isSDXL ? 'sdxl' : 'sd1'];
//   if (draft) {
//     // Fix quantity
//     if (params.quantity % 4 !== 0) params.quantity = Math.ceil(params.quantity / 4) * 4;
//     // Fix other params
//     params.steps = draftModeSettings.steps;
//     params.cfgScale = draftModeSettings.cfgScale;
//     params.sampler = draftModeSettings.sampler;
//     // Add speed up resources
//     resources.push({
//       modelType: ModelType.LORA,
//       strength: 1,
//       id: draftModeSettings.resourceId,
//     });
//   }

//   const resourceData = await resourceDataCache.fetch(resources.map((x) => x.id));
//   const allResourcesAvailable = resourceData.every(
//     (x) => !!x.covered || x.id === draftModeSettings.resourceId
//   );
//   if (!allResourcesAvailable)
//     throw throwBadRequestError('Some of your resources are not available for generation');

//   // const access = await checkResourcesAccess(resources, userId).catch(() => false);
//   // if (!access)
//   //   throw throwAuthorizationError('You do not have access to some of the selected resources');

//   const checkpoint = resources.find((x) => x.modelType === ModelType.Checkpoint);
//   if (!checkpoint)
//     throw throwBadRequestError('A checkpoint is required to make a generation request');

//   const { additionalResourceTypes, aspectRatios } = getGenerationConfig(params.baseModel);
//   if (params.aspectRatio.includes('x'))
//     throw throwBadRequestError('Invalid size. Please select your size and try again');
//   const { height, width } = aspectRatios[Number(params.aspectRatio)];

//   // External prompt moderation
//   let moderationResult = { flagged: false, categories: [] } as AsyncReturnType<
//     typeof extModeration.moderatePrompt
//   >;
//   try {
//     moderationResult = await extModeration.moderatePrompt(params.prompt);
//   } catch (e) {
//     const error = e as Error;
//     logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
//   }
//   if (moderationResult.flagged) {
//     throw throwBadRequestError(
//       `Your prompt was flagged for: ${moderationResult.categories.join(', ')}`
//     );
//   }

//   // const additionalResourceTypes = getGenerationConfig(params.baseModel).additionalResourceTypes;

//   const additionalNetworks = resources
//     .filter((x) => additionalResourceTypes.map((x) => x.type).includes(x.modelType as any))
//     .reduce((acc, { id, modelType, ...rest }) => {
//       acc[`@civitai/${id}`] = { type: modelType, ...rest };
//       return acc;
//     }, {} as { [key: string]: object });

//   // Set nsfw to true if the prompt contains nsfw words
//   const isPromptNsfw = includesNsfw(params.prompt);
//   nsfw ??= isPromptNsfw !== false;

//   // Disable nsfw if the prompt contains minor words
//   // POI is handled via SPMs within the worker
//   if (includesMinor(params.prompt)) nsfw = false;

//   const negativePrompts = [negativePrompt ?? ''];
//   if (!nsfw && status.sfwEmbed) {
//     for (const { id, triggerWord } of safeNegatives) {
//       additionalNetworks[`@civitai/${id}`] = {
//         triggerWord,
//         type: ModelType.TextualInversion,
//       };
//       negativePrompts.unshift(triggerWord);
//     }
//   }

//   // Inject fallback minor safety nets
//   const positivePrompts = [params.prompt];
//   if (isPromptNsfw && status.minorFallback) {
//     for (const { id, triggerWord } of minorPositives) {
//       additionalNetworks[`@civitai/${id}`] = {
//         triggerWord,
//         type: ModelType.TextualInversion,
//       };
//       positivePrompts.unshift(triggerWord);
//     }
//     for (const { id, triggerWord } of minorNegatives) {
//       additionalNetworks[`@civitai/${id}`] = {
//         triggerWord,
//         type: ModelType.TextualInversion,
//       };
//       negativePrompts.unshift(triggerWord);
//     }
//   }

//   const vae = resources.find((x) => x.modelType === ModelType.VAE);
//   if (vae && !isSDXL) {
//     additionalNetworks[`@civitai/${vae.id}`] = {
//       type: ModelType.VAE,
//     };
//   }

//   // handle SDXL ClipSkip
//   // I was made aware that SDXL only works with clipSkip 2
//   // if that's not the case anymore, we can rollback to just setting
//   // this for Pony resources -Manuel
//   if (isSDXL) params.clipSkip = 2;

//   const generationRequest = {
//     userId,
//     nsfw,
//     priority: draft ? env.DRAFT_MODE_PRIORITY : undefined,
//     job: {
//       model: `@civitai/${checkpoint.id}`,
//       baseModel: baseModelToOrchestration[params.baseModel as BaseModelSetType],
//       quantity: params.quantity,
//       sequential: draft ? true : false,
//       providers: draft ? env.DRAFT_MODE_PROVIDERS : undefined,
//       additionalNetworks,
//       params: {
//         prompt: positivePrompts.join(', '),
//         negativePrompt: negativePrompts.join(', '),
//         scheduler: samplersToSchedulers[params.sampler as Sampler],
//         steps: params.steps,
//         cfgScale: params.cfgScale,
//         height,
//         width,
//         seed: params.seed,
//         clipSkip: params.clipSkip,
//       },
//     },
//   };

//   // console.log('________');
//   // console.log(JSON.stringify(generationRequest));
//   // console.log('________');

//   const schedulerUrl = new URL(`${env.SCHEDULER_ENDPOINT}/requests`);
//   if (status.charge) schedulerUrl.searchParams.set('charge', 'true');
//   if (params.staging) schedulerUrl.searchParams.set('staging', 'true');
//   // if (draft) schedulerUrl.searchParams.set('batch', 'true'); // Disable batching for now

//   const response = await fetch(schedulerUrl.toString(), {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify(generationRequest),
//   });

//   // console.log('________');
//   // console.log(response);
//   // console.log('________');

//   if (response.status === 429) {
//     // too many requests
//     throw throwRateLimitError();
//   }

//   if (response.status === 403) {
//     throw throwInsufficientFundsError();
//   }

//   if (!response.ok) {
//     const message = await response.json();
//     throw throwBadRequestError(message);
//   }

//   const data: Generation.Api.RequestProps = await response.json();
//   const [formatted] = await formatGenerationRequests([data]);
//   return formatted;
// };

// export async function getGenerationRequestById({ id }: GetByIdInput) {
//   const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`);
//   if (!response) throw throwNotFoundError();

//   const data: Generation.Api.RequestProps = await response.json();
//   const [request] = await formatGenerationRequests([data]);
//   return request;
// }

// export async function deleteGenerationRequest({ id, userId }: GetByIdInput & { userId: number }) {
//   const getResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`);
//   if (!getResponse) throw throwNotFoundError();

//   const request: Generation.Api.RequestProps = await getResponse.json();
//   if (request.userId !== userId) throw throwAuthorizationError();

//   const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`, {
//     method: 'DELETE',
//   });

//   if (!deleteResponse.ok) throw throwNotFoundError();
// }

// export async function bulkDeleteGeneratedImages({
//   ids,
//   userId,
//   cancelled,
// }: BulkDeleteGeneratedImagesInput & { userId: number }) {
//   const queryString = QS.stringify({ imageId: ids, userId, cancelled });
//   const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/images?${queryString}`, {
//     method: 'DELETE',
//   });
//   if (!deleteResponse.ok) throw throwNotFoundError();

//   return deleteResponse.ok;
// }

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
};

export const getGenerationData = async (props: GetGenerationDataInput): Promise<GenerationData> => {
  switch (props.type) {
    case 'image':
      return await getImageGenerationData(props.id);
    case 'modelVersion':
      return await getResourceGenerationData({ modelVersionId: props.id });
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
  };
};

const defaultCheckpointData: Partial<Record<BaseModelSetType, ResourceData>> = {};
const getImageGenerationData = async (id: number) => {
  const [image, imageResources] = await dbRead.$transaction([
    dbRead.image.findUnique({
      where: { id },
      select: {
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
  };
};

// TODO.orchestrator
export async function prepareModelInOrchestrator({ id }: PrepareModelInput) {
  await orchestratorCaller.bustModelCache({ modelVersionId: id });
}

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

// export const sendGenerationFeedback = async ({
//   jobId,
//   reason,
//   message,
//   userId,
//   ip,
// }: SendFeedbackInput & { userId: number; ip: string }) => {
//   const response = await orchestratorCaller.taintJobById({
//     id: jobId,
//     payload: { reason, context: { imageHash: jobId, message } },
//   });

//   if (response.status === 404) throw throwNotFoundError();
//   if (!response.ok) throw new Error('An unknown error occurred. Please try again later');

//   await generatorFeedbackReward
//     .apply(
//       {
//         jobId,
//         userId,
//       },
//       ip
//     )
//     .catch(handleLogError);

//   return response;
// };

// export const textToImageTestRun = async ({
//   model,
//   baseModel,
//   quantity,
//   sampler,
//   steps,
//   aspectRatio,
//   draft,
//   resources,
// }: GenerationRequestTestRunSchema) => {
//   const { aspectRatios } = getGenerationConfig(baseModel);

//   if (aspectRatio.includes('x'))
//     throw throwBadRequestError('Invalid size. Please select your size and try again');

//   const { height, width } = aspectRatios[Number(aspectRatio)];

//   if (draft) {
//     const draftData = getDraftStateFromInputForOrchestrator({
//       baseModel: baseModel,
//       quantity: quantity,
//       steps: steps,
//       cfgScale: 0,
//       sampler: sampler,
//     });

//     quantity = draftData.quantity;
//     steps = draftData.steps;
//     sampler = draftData.sampler;
//     if (!resources) resources = [];
//     resources.push(draftData.resourceId);
//   }

//   const isSd1 = baseModel === 'SD1';
//   if (!model) model = isSd1 ? 128713 : 128078;
//   const response = await orchestratorCaller.textToImage({
//     payload: {
//       model: `@civitai/${model}`,
//       baseModel: baseModelToOrchestration[baseModel as BaseModelSetType],
//       properties: {},
//       quantity: quantity,
//       additionalNetworks: Object.fromEntries(
//         resources?.map((id) => [`@civitai/${id}`, { type: ModelType.LORA, strength: 1 }]) ?? []
//       ),
//       params: {
//         baseModel,
//         scheduler: samplersToSchedulers[sampler as Sampler],
//         steps,
//         height,
//         width,
//         // Defaults - These are not used for calculating cost
//         prompt: '',
//         negativePrompt: '',
//         clipSkip: 7,
//         cfgScale: 7,
//       },
//     },
//     isTestRun: true,
//   });

//   if (!response.ok) {
//     if (response.status === 403) {
//       throw throwInsufficientFundsError();
//     }

//     throw new Error('An unknown error occurred. Please try again later');
//   }

//   const jobs = response.data?.jobs ?? [];
//   const cost = Math.ceil(jobs.reduce((acc, job) => acc + job.cost, 0));
//   let position = 0;
//   let ready = false;
//   let eta = dayjs().add(10, 'minutes').toDate();
//   for (const job of jobs) {
//     for (const [name, provider] of Object.entries(job.serviceProviders)) {
//       if (provider.support === 'Available' && !ready) ready = true;
//       if (!provider.queuePosition) continue;
//       if (provider.queuePosition.precedingJobs < position)
//         position = provider.queuePosition.precedingJobs;
//       if (provider.queuePosition.estimatedStartDate < eta)
//         eta = provider.queuePosition.estimatedStartDate;
//     }
//   }

//   return {
//     cost,
//     ready,
//     eta,
//     position,
//   };
// };
