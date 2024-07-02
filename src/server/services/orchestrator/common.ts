import { createCivitaiClient } from '@civitai/client';
import { resourceDataCache } from '~/server/redis/caches';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { GenerationStatus, generationStatusSchema } from '~/server/schema/generation.schema';
import {
  InjectableResource,
  allInjectableResourceIds,
  getBaseModelSetType,
  getInjectablResources,
  getWorkflowDefinitionFeatures,
  samplersToSchedulers,
  sanitizeTextToImageParams,
} from '~/shared/constants/generation.constants';
import { stringifyAIR } from '~/utils/string-helpers';
import { env } from '~/env/server.mjs';
import { isDefined } from '~/utils/type-guards';
import {
  TextToImageParams,
  TextToImageStepParamsMetadata,
  textToImageCreateSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import { WorkflowDefinition } from '~/server/services/orchestrator/types';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { getGenerationConfig } from '~/server/common/constants';
import { SessionUser } from 'next-auth';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { z } from 'zod';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { ModelType } from '@prisma/client';

export function createOrchestratorClient(token: string) {
  return createCivitaiClient({
    env: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
    auth: token,
  });
}

/** Used to perform orchestrator operations with the system user account */
export const internalOrchestratorClient = createOrchestratorClient(env.ORCHESTRATOR_API_TOKEN);

export async function getGenerationStatus() {
  const status = generationStatusSchema.parse(
    JSON.parse((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, REDIS_KEYS.GENERATION.STATUS)) ?? '{}')
  );

  return status as GenerationStatus;
}

export type AirResourceData = AsyncReturnType<typeof getResourceDataWithAirs>[number];
export async function getResourceDataWithAirs(versionIds: number[]) {
  const resources = await resourceDataCache.fetch(versionIds);
  return resources.map((resource) => ({
    ...resource,
    air: stringifyAIR({
      baseModel: resource.baseModel,
      type: resource.model.type,
      source: 'civitai',
      modelId: resource.model.id,
      id: resource.id,
    }),
  }));
}

export async function getResourceDataWithInjects<T extends AirResourceData>(
  modelVersionIds: number[],
  cb?: (resource: AirResourceData) => T
) {
  const ids = [...modelVersionIds, ...allInjectableResourceIds];
  const results = await getResourceDataWithAirs(ids);
  const allResources = (cb ? results.map(cb) : results) as T[];

  return {
    resources: allResources.filter((x) => !allInjectableResourceIds.includes(x.id)),
    injectable: allResources.filter((x) => allInjectableResourceIds.includes(x.id)),
  };
}

export async function validateGenerationResources({
  user,
  params,
  ...parsedInput
}: z.infer<typeof textToImageCreateSchema> & {
  user: SessionUser;
}) {
  const status = await getGenerationStatus();
  const limits = status.limits[user.tier ?? 'free'];

  if (!status.available && !user.isModerator)
    throw throwBadRequestError('Generation is currently disabled');

  if (parsedInput.resources.length > limits.resources)
    throw throwBadRequestError('You have exceed the number of allowed resources.');

  const resourceDataWithInjects = await getResourceDataWithInjects(
    parsedInput.resources.map((x) => x.id),
    (resource) => ({
      ...resource,
      ...parsedInput.resources.find((x) => x.id === resource.id),
      triggerWord: resource.trainedWords?.[0],
    })
  );
  const { resources, injectable } = resourceDataWithInjects;

  const checkpoint = resources.find((x) => x.model.type === ModelType.Checkpoint);
  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');
  if (params.baseModel !== getBaseModelSetType(checkpoint.baseModel))
    throw throwBadRequestError(
      `Invalid base model. Checkpoint with baseModel: ${checkpoint.baseModel} does not match the input baseModel: ${params.baseModel}`
    );

  const injectableResources = getInjectablResources(params.baseModel);

  // handle missing draft resource
  if (params.draft && !injectableResources.draft)
    throw throwBadRequestError(`Draft mode is currently disabled for ${params.baseModel} models`);

  // handle missing coverage
  if (!resources.every((x) => !!x.covered))
    throw throwBadRequestError(
      `Some of your resources are not available for generation: ${resources
        .filter((x) => !x.covered)
        .map((x) => x.air)
        .join(', ')}`
    );

  const config = getGenerationConfig(params.baseModel);
  const availableResourceTypes = config.additionalResourceTypes.map((x) => x.type);

  return {
    checkpoint,
    resources: [
      checkpoint,
      ...resources.filter((x) => availableResourceTypes.includes(x.model.type)),
    ],
    injectable,
    status,
  };
}

export async function generationParamsToOrchestrator<
  T extends TextToImageParams,
  TResource extends AirResourceData
>({
  params,
  resources,
  workflowDefinition,
  injectable: allInjectable,
  status,
  user,
}: {
  params: T;
  resources: TResource[];
  workflowDefinition: WorkflowDefinition;
  injectable: TResource[];
  status: GenerationStatus;
  user: SessionUser;
}) {
  const limits = status.limits[user.tier ?? 'free'];
  params = sanitizeTextToImageParams(params, limits);

  // remove data not allowed by workflow features
  const features = getWorkflowDefinitionFeatures(workflowDefinition);
  for (const key in features) {
    if (!features[key as keyof typeof features]) delete params[key as keyof typeof features];
  }

  // handle moderate prompt
  try {
    const moderationResult = await extModeration.moderatePrompt(params.prompt);
    if (moderationResult.flagged) {
      throw throwBadRequestError(
        `Your prompt was flagged for: ${moderationResult.categories.join(', ')}`
      );
    }
  } catch (error: any) {
    logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
  }

  const hasMinorResource = resources.some((resource) => resource.model.minor);
  if (hasMinorResource) params.nsfw = false;

  // Disable nsfw if the prompt contains poi/minor words
  const hasPoi = includesPoi(params.prompt) || resources.some((x) => x.model.poi);
  if (hasPoi || includesMinor(params.prompt)) params.nsfw = false;

  // Set nsfw to true if the prompt contains nsfw words
  const isPromptNsfw = includesNsfw(params.prompt);
  params.nsfw ??= isPromptNsfw !== false;

  const metadataParams = { ...params };

  const injectableResources = getInjectablResources(params.baseModel);

  const injectable: InjectableResource[] = [];
  if (params.draft && injectableResources.draft) {
    injectable.push(injectableResources.draft);
  }
  if (isPromptNsfw && status.minorFallback) {
    injectable.push(injectableResources.safe_pos);
    injectable.push(injectableResources.safe_neg);
  }
  if (!params.nsfw && status.sfwEmbed) {
    injectable.push(injectableResources.civit_nsfw);
  }

  const positivePrompts = [params.prompt];
  const negativePrompts = [params.negativePrompt];
  const resourcesToInject: TResource[] = [];
  for (const item of injectable) {
    const resource = allInjectable.find((x) => x.id === item.id);
    if (!resource) continue;
    resourcesToInject.push(resource);

    const triggerWord = resource.trainedWords?.[0];
    if (triggerWord) {
      if (item.triggerType === 'negative') negativePrompts.unshift(triggerWord);
      if (item.triggerType === 'positive') positivePrompts.unshift(triggerWord);
    }

    if (item.sanitize) {
      const sanitized = item.sanitize(params);
      for (const key in sanitized) {
        // only assign to step metadata if no value has already been assigned
        Object.assign(params, {
          [key as keyof TextToImageStepParamsMetadata]:
            sanitized[key as keyof TextToImageStepParamsMetadata],
        });
      }
    }
  }

  let quantity = params.quantity;
  let batchSize = 1;
  if (params.draft) {
    quantity = Math.ceil(params.quantity / 4);
    batchSize = 4;
  }

  const config = getGenerationConfig(params.baseModel);
  const { width, height } = config.aspectRatios[Number(params.aspectRatio)];

  function getSize(size: number) {
    return params.upscale ? Math.ceil((size * params.upscale) / 64) * 64 : undefined;
  }

  return {
    resourcesToInject,
    metadataParams,
    params: {
      quantity,
      batchSize,
      prompt: positivePrompts.join(', '),
      negativePrompt: negativePrompts.join(', '),
      sampler: params.sampler,
      steps: params.steps,
      cfgScale: params.cfgScale,
      seed: params.seed,
      clipSkip: params.clipSkip,
      denoise: params.denoise,
      width,
      height,
      // temp
      upscaleWidth: getSize(width),
      upscaleHeight: getSize(height),
    },
  };
}

export function generationParamsFromOrchestrator<T extends Partial<TextToImageParams>>({
  params,
  metadataParams = {},
  versionIds,
  injectable: allInjectable,
}: {
  params: T;
  metadataParams?: TextToImageStepParamsMetadata;
  versionIds: number[];
  injectable?: AirResourceData[];
}) {
  const injectable = getInjectablResources(params.baseModel ?? 'SD1');
  let prompt = params.prompt ?? '';
  let negativePrompt = params.negativePrompt ?? '';
  if (allInjectable) {
    for (const item of Object.values(injectable).filter(isDefined)) {
      const resource = allInjectable.find((x) => x.id === item.id);
      if (!resource) continue;
      const triggerWord = resource.trainedWords?.[0];
      if (triggerWord) {
        if (item?.triggerType === 'negative')
          negativePrompt = negativePrompt.replace(`${triggerWord}, `, '');
        if (item?.triggerType === 'positive') prompt = prompt.replace(`${triggerWord}, `, '');
      }
    }
  }

  // infer draft from resources if not included in meta params
  const isDraft = injectable.draft ? versionIds.includes(injectable.draft.id) : false;

  // infer nsfw from resources if not included in meta params
  const isNsfw = !versionIds.includes(injectable.civit_nsfw.id);

  let quantity = params.quantity ?? 1;
  if (isDraft) {
    quantity *= 4;
  }

  const sampler = Object.entries(samplersToSchedulers).find(
    ([sampler, scheduler]) => scheduler.toLowerCase() === params.sampler?.toLowerCase()
  )?.[0];

  return {
    ...params,
    draft: isDraft,
    nsfw: isNsfw,
    prompt,
    negativePrompt,
    quantity,
    sampler,
    ...metadataParams,
  };
}
