import { Scheduler, createCivitaiClient } from '@civitai/client';
import { resourceDataCache } from '~/server/redis/caches';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { GenerationStatus, generationStatusSchema } from '~/server/schema/generation.schema';
import {
  InjectableResource,
  allInjectableResourceIds,
  getInjectablResources,
  getWorkflowDefinitionFeatures,
  samplersToSchedulers,
} from '~/shared/constants/generation.constants';
import { stringifyAIR } from '~/utils/string-helpers';
import { env } from '~/env/server.mjs';
import { isDefined } from '~/utils/type-guards';
import {
  TextToImageParams,
  TextToImageStepParamsMetadata,
} from '~/server/schema/orchestrator/textToImage.schema';
import { WorkflowDefinition } from '~/server/services/orchestrator/types';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { getGenerationConfig } from '~/server/common/constants';

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

// export function

export function generationParamsToOrchestrator<
  T extends TextToImageParams,
  TResource extends AirResourceData
>({
  params,
  resources,
  workflowDefinition,
  injectable: allInjectable,
  status,
}: {
  params: T;
  resources: TResource[];
  workflowDefinition: WorkflowDefinition;
  injectable: TResource[];
  status: GenerationStatus;
}) {
  // remove data not allowed by workflow features
  const features = getWorkflowDefinitionFeatures(workflowDefinition);
  for (const key in features) {
    if (!features[key as keyof typeof features]) delete params[key as keyof typeof features];
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
  const additionalNetworkResources: TResource[] = [];
  for (const item of injectable) {
    const resource = allInjectable.find((x) => x.id === item.id);
    if (!resource) continue;
    additionalNetworkResources.push(resource);

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
  let { width, height } = config.aspectRatios[Number(params.aspectRatio)];
  if (params.upscale) {
    width = width * params.upscale;
    height = height * params.upscale;
  }

  return {
    additionalNetworkResources,
    metadataParams,
    params: {
      quantity,
      batchSize,
      prompt: positivePrompts.join(', '),
      negativePrompt: negativePrompts.join(', '),
      scheduler: samplersToSchedulers[
        params.sampler as keyof typeof samplersToSchedulers
      ] as Scheduler,
      steps: params.steps,
      cfgScale: params.cfgScale,
      seed: params.seed,
      clipSkip: params.clipSkip,
      denoise: params.denoise,
      width,
      height,
    },
  };
}

function generationParamsFromOrchestrator<T extends Partial<TextToImageParams>>({
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
