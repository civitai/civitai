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
  SendFeedbackInput,
} from '~/server/schema/generation.schema';
import { SessionUser } from 'next-auth';
import { dbRead } from '~/server/db/client';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
  throwNotFoundError,
  throwRateLimitError,
  withRetries,
} from '~/server/utils/errorHandling';
import { Availability, ModelType, Prisma } from '@prisma/client';
import {
  GenerationResourceSelect,
  generationResourceSelect,
} from '~/server/selectors/generation.selector';
import { Generation } from '~/server/services/generation/generation.types';
import { isDefined } from '~/utils/type-guards';
import { QS } from '~/utils/qs';
import { env } from '~/env/server.mjs';

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
import { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import orchestratorCaller from '~/server/http/orchestrator/orchestrator.caller';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { hasEntityAccess } from '~/server/services/common.service';
import { includesNsfw, includesPoi, includesMinor } from '~/utils/metadata/audit';
import { fromJson, toJson } from '~/utils/json-helpers';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { getPagedData } from '~/server/utils/pagination-helpers';
import { modelsSearchIndex } from '~/server/search-index';
import { createLimiter } from '~/server/utils/rate-limiting';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';
import { SearchIndexUpdateQueueAction, GenerationRequestStatus } from '~/server/common/enums';
import { UserTier } from '~/server/schema/user.schema';
import { Orchestrator } from '~/server/http/orchestrator/orchestrator.types';
import { generatorFeedbackReward } from '~/server/rewards';
import { resourceDataCache } from '~/server/redis/caches';
import {
  allInjectedNegatives,
  allInjectedPositives,
  defaultCheckpoints,
  getBaseModelSetKey,
  minorNegatives,
  minorPositives,
  safeNegatives,
} from '~/shared/constants/generation.constants';

export function parseModelVersionId(assetId: string) {
  const pattern = /^@civitai\/(\d+)$/;
  const match = assetId.match(pattern);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

function mapRequestStatus(label: string): GenerationRequestStatus {
  switch (label) {
    case 'Pending':
      return GenerationRequestStatus.Pending;
    case 'Processing':
      return GenerationRequestStatus.Processing;
    case 'Cancelled':
      return GenerationRequestStatus.Cancelled;
    case 'Error':
      return GenerationRequestStatus.Error;
    case 'Succeeded':
      return GenerationRequestStatus.Succeeded;
    default:
      throw new Error(`Invalid status label: ${label}`);
  }
}

function mapGenerationResource(
  resource: GenerationResourceSelect & { settings?: RecommendedSettingsSchema | null }
): Generation.Resource {
  const { model, settings, ...x } = resource;
  return {
    id: x.id,
    name: x.name,
    trainedWords: x.trainedWords,
    modelId: model.id,
    modelName: model.name,
    modelType: model.type,
    baseModel: x.baseModel,
    strength: settings?.strength ?? 1,
    minStrength: settings?.minStrength ?? -1,
    maxStrength: settings?.maxStrength ?? 2,
  };
}

const baseModelSetsArray = Object.values(baseModelSets);
/** @deprecated using search index instead... */
export const getGenerationResources = async (
  input: GetGenerationResourcesInput & { user?: SessionUser }
) => {
  return await getPagedData<GetGenerationResourcesInput, Generation.Resource[]>(
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

      const results = await dbRead.$queryRaw<Array<Generation.Resource & { index: number }>>`
        SELECT
          mv.id,
          mv.index,
          mv.name,
          mv."trainedWords",
          m.id "modelId",
          m.name "modelName",
          m.type "modelType",
          mv."baseModel"
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

function getResourceData(modelVersionIds: number[]) {
  return resourceDataCache.fetch(modelVersionIds);
}
export function deleteResourceDataCache(modelVersionIds: number | number[]) {
  return resourceDataCache.bust(modelVersionIds);
}

const baseModelSetsEntries = Object.entries(baseModelSets);

const formatGenerationRequests = async (requests: Generation.Api.RequestProps[]) => {
  const modelVersionIds = requests
    .map((x) => parseModelVersionId(x.job.model))
    .concat(
      requests.flatMap((x) => Object.keys(x.job.additionalNetworks ?? {}).map(parseModelVersionId))
    )
    .filter((x) => x !== null) as number[];

  const modelVersions = await getResourceData(modelVersionIds);

  const checkpoint = modelVersions.find((x) => x.model.type === 'Checkpoint');
  const baseModel = checkpoint
    ? (baseModelSetsEntries.find(([, v]) =>
        v.includes(checkpoint.baseModel as BaseModel)
      )?.[0] as BaseModelSetType)
    : undefined;

  // const alternativesAvailable =
  //   ((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, 'generation:alternatives')) ?? 'false') ===
  //   'true';

  return requests.map((x): Generation.Request => {
    const { additionalNetworks = {}, params, ...job } = x.job;

    let assets = [x.job.model, ...Object.keys(x.job.additionalNetworks ?? {})];

    // scrub negative prompt
    let negativePrompt = params.negativePrompt ?? '';
    for (const { triggerWord, id } of allInjectedNegatives) {
      negativePrompt = negativePrompt.replace(`${triggerWord}, `, '');
      assets = assets.filter((x) => x !== `@civitai/${id}`);
    }

    let prompt = params.prompt ?? '';
    for (const { triggerWord, id } of allInjectedPositives) {
      prompt = prompt.replace(`${triggerWord}, `, '');
      assets = assets.filter((x) => x !== `@civitai/${id}`);
    }

    const request = {
      id: x.id,
      // alternativesAvailable,
      createdAt: x.createdAt,
      // estimatedCompletionDate: x.estimatedCompletedAt,
      status: mapRequestStatus(x.status),
      // queuePosition: x.queuePosition,
      cost: x.cost,
      params: {
        ...params,
        prompt,
        baseModel,
        negativePrompt,
        seed: params.seed === -1 ? undefined : params.seed,
        sampler: Object.entries(samplersToSchedulers).find(
          ([sampler, scheduler]) => scheduler === params.scheduler
        )?.[0],
      },
      resources: assets
        .map((assetId): Generation.Resource | undefined => {
          const modelVersionId = parseModelVersionId(assetId);
          const modelVersion = modelVersions.find((x) => x.id === modelVersionId);
          const network = x.job.additionalNetworks?.[assetId] ?? {};
          if (!modelVersion) return undefined;
          const { model } = modelVersion;
          return {
            id: modelVersion.id,
            name: modelVersion.name,
            trainedWords: modelVersion.trainedWords,
            modelId: model.id,
            modelName: model.name,
            modelType: model.type,
            baseModel: modelVersion.baseModel,
            ...network,
          };
        })
        .filter(isDefined),
      ...job,
      images: x.images
        ?.map(({ jobToken, ...image }) => image)
        .sort((a, b) => (b.duration ?? 1) - (a.duration ?? 1)),
    };

    // if (alternativesAvailable) request.alternativesAvailable = true;

    return request;
  });
};

export type GetGenerationRequestsReturn = AsyncReturnType<typeof getGenerationRequests>;
export const getGenerationRequests = async (
  props: GetGenerationRequestsOutput & { userId: number }
) => {
  const params = QS.stringify(props);
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  const { cursor, requests }: Generation.Api.Request = await response.json();

  const items = await formatGenerationRequests(requests);

  return {
    items: items.filter((x) => !!x.images?.length),
    nextCursor: cursor === 0 ? undefined : cursor ?? undefined,
  };
};

const samplersToSchedulers: Record<Sampler, string> = {
  'Euler a': 'EulerA',
  Euler: 'Euler',
  LMS: 'LMS',
  Heun: 'Heun',
  DPM2: 'DPM2',
  'DPM2 a': 'DPM2A',
  'DPM++ 2S a': 'DPM2SA',
  'DPM++ 2M': 'DPM2M',
  'DPM++ 2M SDE': 'DPM2MSDE',
  'DPM++ SDE': 'DPMSDE',
  'DPM fast': 'DPMFast',
  'DPM adaptive': 'DPMAdaptive',
  'LMS Karras': 'LMSKarras',
  'DPM2 Karras': 'DPM2Karras',
  'DPM2 a Karras': 'DPM2AKarras',
  'DPM++ 2S a Karras': 'DPM2SAKarras',
  'DPM++ 2M Karras': 'DPM2MKarras',
  'DPM++ 2M SDE Karras': 'DPM2MSDEKarras',
  'DPM++ SDE Karras': 'DPMSDEKarras',
  'DPM++ 3M SDE': 'DPM3MSDE',
  'DPM++ 3M SDE Karras': 'DPM3MSDEKarras',
  'DPM++ 3M SDE Exponential': 'DPM3MSDEExponential',
  DDIM: 'DDIM',
  PLMS: 'PLMS',
  UniPC: 'UniPC',
  LCM: 'LCM',
};

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

async function checkResourcesAccess(
  resources: CreateGenerationRequestInput['resources'],
  userId: number
) {
  const data = await getResourceData(resources.map((x) => x.id));
  const hasPrivateResources = data.some((x) => x.availability === Availability.Private);

  if (hasPrivateResources) {
    // Check for permission:
    const entityAccess = await hasEntityAccess({
      entityIds: data.map((d) => d.id),
      entityType: 'ModelVersion',
      userId,
    });

    return entityAccess.every((a) => a.hasAccess);
  }

  return true;
}

// TODO.imageGenerationBuzzCharge - Remove all limiters. Generation will not be limited as it's now using buzz.
const generationLimiter = createLimiter({
  counterKey: REDIS_KEYS.GENERATION.COUNT,
  limitKey: REDIS_KEYS.GENERATION.LIMITS,
  fetchCount: async (userKey) => {
    if (!clickhouse) return 0;

    const data = await clickhouse.$query<{ cost: number }>`
      SELECT SUM(jobCost) as cost
      FROM orchestration.textToImageJobs
      WHERE userId = ${userKey} AND createdAt > subtractHours(now(), 24);
    `;
    const cost = data?.[0]?.cost ?? 0;
    return cost;
  },
});

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

  return { quantity, steps, cfgScale, sampler };
};

export const prepareGenerationInput = async ({
  userId,
  resources,
  params: { nsfw, negativePrompt, draft, ...params },
}: CreateGenerationRequestInput & {
  userId: number;
}) => {
  const { additionalResourceTypes, aspectRatios } = getGenerationConfig(params.baseModel);
  const status = await getGenerationStatus();
  const isPromptNsfw = includesNsfw(params.prompt);
  nsfw ??= isPromptNsfw !== false;

  if (params.aspectRatio.includes('x'))
    throw throwBadRequestError('Invalid size. Please select your size and try again');

  const { height, width } = aspectRatios[Number(params.aspectRatio)];

  const checkpoint = resources.find((x) => x.modelType === ModelType.Checkpoint);

  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');

  const isSDXL = params.baseModel === 'SDXL' || params.baseModel === 'Pony';

  if (draft) {
    const draftData = getDraftStateFromInputForOrchestrator({
      baseModel: params.baseModel,
      quantity: params.quantity,
      steps: params.steps,
      cfgScale: params.cfgScale,
      sampler: params.sampler,
    });

    const draftModeSettings = draftMode[isSDXL ? 'sdxl' : 'sd1'];
    // Fix quantity
    params.quantity = draftData.quantity;
    // Fix other params
    params.steps = draftData.steps;
    params.cfgScale = draftData.cfgScale;
    params.sampler = draftData.sampler;
    // Add speed up resources
    resources.push({
      modelType: ModelType.LORA,
      strength: 1,
      id: draftModeSettings.resourceId,
    });
  }

  const additionalNetworks = resources
    .filter((x) => additionalResourceTypes.map((x) => x.type).includes(x.modelType as any))
    .reduce(
      (acc, { id, modelType, ...rest }) => {
        acc[`@civitai/${id}`] = { type: modelType, ...rest };
        return acc;
      },
      {} as {
        [key: string]: {
          type: string;
          strength?: number;
          triggerWord?: string;
        };
      }
    );

  const negativePrompts = [negativePrompt ?? ''];
  if (!nsfw && status.sfwEmbed) {
    for (const { id, triggerWord } of safeNegatives) {
      additionalNetworks[`@civitai/${id}`] = {
        triggerWord,
        type: ModelType.TextualInversion,
      };
      negativePrompts.unshift(triggerWord);
    }
  }

  const positivePrompts = [params.prompt];
  if (isPromptNsfw && status.minorFallback) {
    for (const { id, triggerWord } of minorPositives) {
      additionalNetworks[`@civitai/${id}`] = {
        triggerWord,
        type: ModelType.TextualInversion,
      };
      positivePrompts.unshift(triggerWord);
    }
    for (const { id, triggerWord } of minorNegatives) {
      additionalNetworks[`@civitai/${id}`] = {
        triggerWord,
        type: ModelType.TextualInversion,
      };
      negativePrompts.unshift(triggerWord);
    }
  }

  const generationRequest = {
    userId,
    nsfw,
    job: {
      model: `@civitai/${checkpoint.id}`,
      baseModel: baseModelToOrchestration[params.baseModel as BaseModelSetType],
      quantity: params.quantity,
      additionalNetworks,
      params: {
        prompt: positivePrompts.join(', '),
        negativePrompt: negativePrompts.join(', '),
        scheduler: samplersToSchedulers[params.sampler as Sampler],
        steps: params.steps,
        cfgScale: params.cfgScale,
        height,
        width,
        seed: params.seed,
        clipSkip: params.clipSkip,
      },
    },
  };

  return generationRequest;
};

export const createGenerationRequest = async ({
  userId,
  userTier,
  isModerator,
  resources,
  params: { nsfw, negativePrompt, draft, ...params },
}: CreateGenerationRequestInput & {
  userId: number;
  userTier?: UserTier;
  isModerator?: boolean;
}) => {
  // Handle generator disabled
  const status = await getGenerationStatus();
  if (!status.available && !isModerator)
    throw throwBadRequestError('Generation is currently disabled');

  // Handle rate limiting
  if (await generationLimiter.hasExceededLimit(userId.toString(), userTier ?? 'free')) {
    const limitHitTime = await generationLimiter.getLimitHitTime(userId.toString());
    let message = 'You have exceeded the daily generation limit.';
    if (!limitHitTime) message += ' Please try again later.';
    else message += ` Please try again ${dayjs(limitHitTime).add(60, 'minutes').fromNow()}.`;
    throw throwRateLimitError(message);
  }

  // Handle the request limits
  const limits = status.limits[userTier ?? 'free'];
  if (params.quantity > limits.quantity) params.quantity = limits.quantity;
  if (params.steps > limits.steps) params.steps = limits.steps;
  if (resources.length > limits.resources)
    throw throwBadRequestError('You have exceeded the resources limit.');

  // This is disabled for now, because it performs so poorly...
  // const requests = await getGenerationRequests({
  //   userId,
  //   status: [GenerationRequestStatus.Pending, GenerationRequestStatus.Processing],
  //   take: limits.queue + 1,
  // });
  // if (requests.items.length >= limits.queue)
  //   throw throwRateLimitError(
  //     'You have too many pending generation requests. Try again when some are completed.'
  //   );

  if (!resources || resources.length === 0) throw throwBadRequestError('No resources provided');
  if (resources.length > 10) throw throwBadRequestError('Too many resources provided');

  // Handle Draft Mode
  const isSDXL =
    params.baseModel === 'SDXL' ||
    params.baseModel === 'Pony' ||
    params.baseModel === 'SDXLDistilled';
  const draftModeSettings = draftMode[isSDXL ? 'sdxl' : 'sd1'];
  if (draft) {
    // Fix quantity
    if (params.quantity % 4 !== 0) params.quantity = Math.ceil(params.quantity / 4) * 4;
    // Fix other params
    params.steps = draftModeSettings.steps;
    params.cfgScale = draftModeSettings.cfgScale;
    params.sampler = draftModeSettings.sampler;
    // Add speed up resources
    resources.push({
      modelType: ModelType.LORA,
      strength: 1,
      id: draftModeSettings.resourceId,
    });
  }

  const resourceData = await getResourceData(resources.map((x) => x.id));
  const allResourcesAvailable = resourceData.every(
    (x) => !!x.generationCoverage?.covered || x.id === draftModeSettings.resourceId
  );
  if (!allResourcesAvailable)
    throw throwBadRequestError('Some of your resources are not available for generation');

  const access = await checkResourcesAccess(resources, userId).catch(() => false);
  if (!access)
    throw throwAuthorizationError('You do not have access to some of the selected resources');

  const checkpoint = resources.find((x) => x.modelType === ModelType.Checkpoint);
  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');

  const { additionalResourceTypes, aspectRatios } = getGenerationConfig(params.baseModel);
  if (params.aspectRatio.includes('x'))
    throw throwBadRequestError('Invalid size. Please select your size and try again');
  const { height, width } = aspectRatios[Number(params.aspectRatio)];

  // External prompt moderation
  let moderationResult = { flagged: false, categories: [] } as AsyncReturnType<
    typeof extModeration.moderatePrompt
  >;
  try {
    moderationResult = await extModeration.moderatePrompt(params.prompt);
  } catch (e) {
    const error = e as Error;
    logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
  }
  if (moderationResult.flagged) {
    throw throwBadRequestError(
      `Your prompt was flagged for: ${moderationResult.categories.join(', ')}`
    );
  }

  // const additionalResourceTypes = getGenerationConfig(params.baseModel).additionalResourceTypes;

  const additionalNetworks = resources
    .filter((x) => additionalResourceTypes.map((x) => x.type).includes(x.modelType as any))
    .reduce((acc, { id, modelType, ...rest }) => {
      acc[`@civitai/${id}`] = { type: modelType, ...rest };
      return acc;
    }, {} as { [key: string]: object });

  // Set nsfw to true if the prompt contains nsfw words
  const isPromptNsfw = includesNsfw(params.prompt);
  nsfw ??= isPromptNsfw !== false;

  // Disable nsfw if the prompt contains minor words
  // POI is handled via SPMs within the worker
  if (includesMinor(params.prompt)) nsfw = false;

  const negativePrompts = [negativePrompt ?? ''];
  if (!nsfw && status.sfwEmbed) {
    for (const { id, triggerWord } of safeNegatives) {
      additionalNetworks[`@civitai/${id}`] = {
        triggerWord,
        type: ModelType.TextualInversion,
      };
      negativePrompts.unshift(triggerWord);
    }
  }

  // Inject fallback minor safety nets
  const positivePrompts = [params.prompt];
  if (isPromptNsfw && status.minorFallback) {
    for (const { id, triggerWord } of minorPositives) {
      additionalNetworks[`@civitai/${id}`] = {
        triggerWord,
        type: ModelType.TextualInversion,
      };
      positivePrompts.unshift(triggerWord);
    }
    for (const { id, triggerWord } of minorNegatives) {
      additionalNetworks[`@civitai/${id}`] = {
        triggerWord,
        type: ModelType.TextualInversion,
      };
      negativePrompts.unshift(triggerWord);
    }
  }

  const vae = resources.find((x) => x.modelType === ModelType.VAE);
  if (vae && !isSDXL) {
    additionalNetworks[`@civitai/${vae.id}`] = {
      type: ModelType.VAE,
    };
  }

  // handle SDXL ClipSkip
  // I was made aware that SDXL only works with clipSkip 2
  // if that's not the case anymore, we can rollback to just setting
  // this for Pony resources -Manuel
  if (isSDXL) params.clipSkip = 2;

  const generationRequest = {
    userId,
    nsfw,
    priority: draft ? env.DRAFT_MODE_PRIORITY : undefined,
    job: {
      model: `@civitai/${checkpoint.id}`,
      baseModel: baseModelToOrchestration[params.baseModel as BaseModelSetType],
      quantity: params.quantity,
      sequential: draft ? true : false,
      providers: draft ? env.DRAFT_MODE_PROVIDERS : undefined,
      additionalNetworks,
      params: {
        prompt: positivePrompts.join(', '),
        negativePrompt: negativePrompts.join(', '),
        scheduler: samplersToSchedulers[params.sampler as Sampler],
        steps: params.steps,
        cfgScale: params.cfgScale,
        height,
        width,
        seed: params.seed,
        clipSkip: params.clipSkip,
      },
    },
  };

  // console.log('________');
  // console.log(JSON.stringify(generationRequest));
  // console.log('________');

  const schedulerUrl = new URL(`${env.SCHEDULER_ENDPOINT}/requests`);
  if (status.charge) schedulerUrl.searchParams.set('charge', 'true');
  if (params.staging) schedulerUrl.searchParams.set('staging', 'true');
  // if (draft) schedulerUrl.searchParams.set('batch', 'true'); // Disable batching for now

  const response = await fetch(schedulerUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(generationRequest),
  });

  // console.log('________');
  // console.log(response);
  // console.log('________');

  if (response.status === 429) {
    // too many requests
    throw throwRateLimitError();
  }

  if (response.status === 403) {
    throw throwInsufficientFundsError();
  }

  if (!response.ok) {
    const message = await response.json();
    throw throwBadRequestError(message);
  }

  // TODO.imageGenerationBuzzCharge - Remove all cost calculation / generation limit from the front-end. This is done by the orchestrator.
  generationLimiter.increment(userId.toString(), params.quantity);

  const data: Generation.Api.RequestProps = await response.json();
  // TODO.imageGenerationBuzzCharge - Remove all cost calculation / generation limit from the front-end. This is done by the orchestrator.
  const [formatted] = await formatGenerationRequests([data]);
  return formatted;
};

export async function getGenerationRequestById({ id }: GetByIdInput) {
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`);
  if (!response) throw throwNotFoundError();

  const data: Generation.Api.RequestProps = await response.json();
  const [request] = await formatGenerationRequests([data]);
  return request;
}

export async function deleteGenerationRequest({ id, userId }: GetByIdInput & { userId: number }) {
  const getResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`);
  if (!getResponse) throw throwNotFoundError();

  const request: Generation.Api.RequestProps = await getResponse.json();
  if (request.userId !== userId) throw throwAuthorizationError();

  const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/requests/${id}`, {
    method: 'DELETE',
  });

  if (!deleteResponse.ok) throw throwNotFoundError();
}

export async function bulkDeleteGeneratedImages({
  ids,
  userId,
  cancelled,
}: BulkDeleteGeneratedImagesInput & { userId: number }) {
  const queryString = QS.stringify({ imageId: ids, userId, cancelled });
  const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/images?${queryString}`, {
    method: 'DELETE',
  });
  if (!deleteResponse.ok) throw throwNotFoundError();

  return deleteResponse.ok;
}

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

export const getGenerationData = async (
  props: GetGenerationDataInput
): Promise<Generation.Data> => {
  switch (props.type) {
    case 'image':
      return await getImageGenerationData(props.id);
    case 'model':
      return await getResourceGenerationData({ modelId: props.id });
    case 'modelVersion':
      return await getResourceGenerationData({ modelVersionId: props.id });
    case 'random':
      return await getRandomGenerationData(props.includeResources);
  }
};

export const getResourceGenerationData = async ({
  modelId,
  modelVersionId,
}: {
  modelId?: number;
  modelVersionId?: number;
}): Promise<Generation.Data> => {
  if (!modelId && !modelVersionId) throw new Error('modelId or modelVersionId required');
  const resource = await dbRead.modelVersion.findFirst({
    where: { id: modelVersionId, modelId },
    select: {
      ...generationResourceSelect,
      clipSkip: true,
      vaeId: true,
    },
  });
  if (!resource) throw throwNotFoundError();
  const resources = [resource];
  if (resource.vaeId) {
    const vae = await dbRead.modelVersion.findFirst({
      where: { id: modelVersionId, modelId },
      select: { ...generationResourceSelect, clipSkip: true },
    });
    if (vae) resources.push({ ...vae, vaeId: null });
  }
  const baseModel = baseModelSetsEntries.find(([, v]) =>
    v.includes(resource.baseModel as BaseModel)
  )?.[0] as BaseModelSetType;
  return {
    resources: resources.map(mapGenerationResource),
    params: {
      baseModel,
      clipSkip: resource.clipSkip ?? undefined,
    },
  };
};

type ResourceUsedRow = Generation.Resource & { covered: boolean; hash?: string; strength?: number };
const defaultCheckpointData: Partial<Record<BaseModelSetType, ResourceUsedRow>> = {};
const getImageGenerationData = async (id: number): Promise<Generation.Data> => {
  const image = await dbRead.image.findUnique({
    where: { id },
    select: {
      meta: true,
      height: true,
      width: true,
    },
  });
  if (!image) throw throwNotFoundError();

  const {
    'Clip skip': legacyClipSkip,
    clipSkip = legacyClipSkip,
    ...meta
  } = imageGenerationSchema.parse(image.meta);

  const resources = await dbRead.$queryRaw<ResourceUsedRow[]>`
    SELECT
      mv.id,
      mv.name,
      mv."trainedWords",
      mv."baseModel",
      m.id "modelId",
      m.name "modelName",
      m.type "modelType",
      ir."hash",
      ir.strength,
      gc.covered
    FROM "ImageResource" ir
    JOIN "ModelVersion" mv on mv.id = ir."modelVersionId"
    JOIN "Model" m on m.id = mv."modelId"
    LEFT JOIN "GenerationCoverage" gc on gc."modelVersionId" = mv.id
    WHERE ir."imageId" = ${id};
  `;

  // if the checkpoint exists but isn't covered, add a default based off checkpoint `modelType`
  const checkpoint = resources.find((x) => x.modelType === 'Checkpoint');
  if (!checkpoint?.covered && checkpoint?.modelType) {
    const baseModel = getBaseModelSetKey(checkpoint.baseModel);
    const defaultCheckpoint = baseModel ? defaultCheckpoints[baseModel as any] : undefined;
    if (baseModel && defaultCheckpoint) {
      if (!defaultCheckpointData[baseModel]) {
        const resource = await dbRead.modelVersion.findFirst({
          where: { id: defaultCheckpoint.version },
          select: generationResourceSelect,
        });
        if (resource) {
          defaultCheckpointData[baseModel] = { ...mapGenerationResource(resource), covered: true };
        }
      }
      if (defaultCheckpointData[baseModel])
        resources.unshift(defaultCheckpointData[baseModel] as ResourceUsedRow);
    }
  }
  const deduped = uniqBy(resources, 'id').filter((x) => x.covered);
  for (const resource of deduped) {
    if (resource.strength) resource.strength /= 100;
  }

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

  const model = deduped.find((x) => x.modelType === 'Checkpoint');
  const baseModel = model
    ? (baseModelSetsEntries.find(([, v]) =>
        v.includes(model.baseModel as BaseModel)
      )?.[0] as BaseModelSetType)
    : undefined;

  // Clean-up bad values
  if (meta.cfgScale == 0) meta.cfgScale = 7;
  if (meta.steps == 0) meta.steps = 30;
  if (meta.seed == 0) meta.seed = undefined;

  return {
    // only send back resources if we have a checkpoint resource
    resources: !model
      ? []
      : deduped.map((resource) => ({
          ...resource,
          strength: resource.strength ?? 1,
        })),
    params: {
      ...meta,
      clipSkip,
      height: image.height ?? undefined,
      width: image.width ?? undefined,
      baseModel,
    },
  };
};

export const getRandomGenerationData = async (includeResources?: boolean) => {
  const imageReaction = await dbRead.imageReaction.findFirst({
    where: {
      reaction: { in: ['Like', 'Heart', 'Laugh'] },
      user: { isModerator: true },
      image: { nsfw: 'None', meta: { not: Prisma.JsonNull } },
    },
    select: { imageId: true },
    orderBy: { createdAt: 'desc' },
    skip: Math.floor(Math.random() * 1000),
  });
  if (!imageReaction) throw throwNotFoundError();

  const { resources, params = {} } = await getImageGenerationData(imageReaction.imageId);
  params.seed = undefined;
  return { resources: includeResources ? resources : [], params };
};

export const deleteAllGenerationRequests = async ({ userId }: { userId: number }) => {
  const deleteResponse = await fetch(`${env.SCHEDULER_ENDPOINT}/requests?userId=${userId}`, {
    method: 'DELETE',
  });

  if (!deleteResponse.ok) throw throwNotFoundError();
};

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

export const sendGenerationFeedback = async ({
  jobId,
  reason,
  message,
  userId,
  ip,
}: SendFeedbackInput & { userId: number; ip: string }) => {
  const response = await orchestratorCaller.taintJobById({
    id: jobId,
    payload: { reason, context: { imageHash: jobId, message } },
  });

  if (response.status === 404) throw throwNotFoundError();
  if (!response.ok) throw new Error('An unknown error occurred. Please try again later');

  await generatorFeedbackReward
    .apply(
      {
        jobId,
        userId,
      },
      ip
    )
    .catch(handleLogError);

  return response;
};

export const textToImage = async ({
  input,
}: {
  input: CreateGenerationRequestInput & {
    userId: number;
  };
}) => {
  const data = await prepareGenerationInput(input);
  const response = await orchestratorCaller.textToImage({
    payload: {
      properties: {},
      ...data.job,
    },
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw throwInsufficientFundsError();
    }

    throw new Error('An unknown error occurred. Please try again later');
  }

  return response.data;
};

export const textToImageTestRun = async ({
  baseModel,
  quantity,
  sampler,
  steps,
  aspectRatio,
  draft,
}: GenerationRequestTestRunSchema) => {
  const { aspectRatios } = getGenerationConfig(baseModel);

  if (aspectRatio.includes('x'))
    throw throwBadRequestError('Invalid size. Please select your size and try again');

  const { height, width } = aspectRatios[Number(aspectRatio)];

  if (draft) {
    const draftData = getDraftStateFromInputForOrchestrator({
      baseModel: baseModel,
      quantity: quantity,
      steps: steps,
      cfgScale: 0,
      sampler: sampler,
    });

    quantity = draftData.quantity;
    steps = draftData.steps;
    sampler = draftData.sampler;
  }

  const isSd1 = baseModel === 'SD1';
  const response = await orchestratorCaller.textToImage({
    payload: {
      model: isSd1 ? `@civitai/128713` : '@civitai/128078',
      baseModel: baseModelToOrchestration[baseModel as BaseModelSetType],
      properties: {},
      quantity: quantity,
      // TODO: in the future we may wanna add additional networks as they might be used for cost calculation.
      // Not the case as of now.
      additionalNetworks: {},
      params: {
        baseModel,
        scheduler: samplersToSchedulers[sampler as Sampler],
        steps,
        height,
        width,
        // Defaults - These are not used for calculating cost
        prompt: '',
        negativePrompt: '',
        clipSkip: 7,
        cfgScale: 7,
      },
    },
    isTestRun: true,
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw throwInsufficientFundsError();
    }

    throw new Error('An unknown error occurred. Please try again later');
  }

  return response.data;
};
