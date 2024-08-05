import {
  Blob,
  ComfyStep,
  ImageJobNetworkParams,
  TextToImageInput,
  TextToImageStep,
  WorkflowStatus,
  WorkflowStep,
  WorkflowStepJob,
  createCivitaiClient,
} from '@civitai/client';
import { resourceDataCache } from '~/server/redis/caches';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { GenerationStatus, generationStatusSchema } from '~/server/schema/generation.schema';
import {
  InjectableResource,
  WORKFLOW_TAGS,
  allInjectableResourceIds,
  formatGenerationResources,
  getBaseModelSetType,
  getInjectablResources,
  getSizeFromAspectRatio,
  samplersToSchedulers,
  sanitizeParamsByWorkflowDefinition,
  sanitizeTextToImageParams,
} from '~/shared/constants/generation.constants';
import { parseAIR, stringifyAIR } from '~/utils/string-helpers';
import { env } from '~/env/server.mjs';
import { isDefined } from '~/utils/type-guards';
import {
  generateImageSchema,
  GeneratedImageStepMetadata,
  TextToImageParams,
} from '~/server/schema/orchestrator/textToImage.schema';
import {
  GeneratedImageWorkflow,
  GeneratedImageWorkflowStep,
  WorkflowDefinition,
} from '~/server/services/orchestrator/types';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { generation, getGenerationConfig } from '~/server/common/constants';
import { SessionUser } from 'next-auth';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { z } from 'zod';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { ModelType } from '@prisma/client';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { NormalizedGeneratedImage } from '~/server/services/orchestrator';

export function createOrchestratorClient(token: string) {
  return createCivitaiClient({
    env: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
    auth: token,
  });
}

/** Used to perform orchestrator operations with the system user account */
export const internalOrchestratorClient = createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN);

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

export async function parseGenerateImageInput({
  user,
  params: originalParams,
  resources: originalResources,
  workflowDefinition,
}: z.infer<typeof generateImageSchema> & {
  user: SessionUser;
  workflowDefinition: WorkflowDefinition;
}) {
  // remove data not allowed by workflow features
  sanitizeParamsByWorkflowDefinition(originalParams, workflowDefinition);

  let params = { ...originalParams };
  const status = await getGenerationStatus();
  const limits = status.limits[user.tier ?? 'free'];
  const resourceLimit = limits.resources;

  if (!status.available && !user.isModerator)
    throw throwBadRequestError('Generation is currently disabled');

  const resourceData = await getResourceDataWithInjects(
    originalResources.map((x) => x.id),
    (resource) => ({
      ...resource,
      ...originalResources.find((x) => x.id === resource.id),
      triggerWord: resource.trainedWords?.[0],
    })
  );

  if (
    resourceData.resources.filter((x) => x.model.type !== 'Checkpoint' && x.model.type !== 'VAE')
      .length > resourceLimit
  )
    throw throwBadRequestError('You have exceed the number of allowed resources.');

  const checkpoint = resourceData.resources.find((x) => x.model.type === ModelType.Checkpoint);
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
  if (!resourceData.resources.every((x) => x.available))
    throw throwBadRequestError(
      `Some of your resources are not available for generation: ${resourceData.resources
        .filter((x) => !x.covered)
        .map((x) => x.air)
        .join(', ')}`
    );

  const config = getGenerationConfig(params.baseModel);
  const availableResourceTypes = config.additionalResourceTypes.map((x) => x.type);
  const availableResources = [
    checkpoint,
    ...resourceData.resources.filter((x) => availableResourceTypes.includes(x.model.type)),
  ];

  // #region [together]
  // TODO - should be able to remove this 30 days after orchestrator integration
  if (params.aspectRatio) {
    const size = getSizeFromAspectRatio(Number(params.aspectRatio), params.baseModel);
    params.width = size.width;
    params.height = size.height;
  }

  // this needs to come after updating the size from the aspect ratio that is done directly above
  params = sanitizeTextToImageParams(params, limits);
  // #endregion

  // handle moderate prompt
  const moderationResult = await extModeration.moderatePrompt(params.prompt).catch((error) => {
    logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
    return { flagged: false, categories: [] as string[] };
  });

  if (moderationResult.flagged) {
    throw throwBadRequestError(
      `Your prompt was flagged for: ${moderationResult.categories.join(', ')}`
    );
  }

  const hasMinorResource = availableResources.some((resource) => resource.model.minor);
  if (hasMinorResource) params.nsfw = false;

  // Disable nsfw if the prompt contains poi/minor words
  const hasPoi = includesPoi(params.prompt) || availableResources.some((x) => x.model.poi);
  if (hasPoi || includesMinor(params.prompt)) params.nsfw = false;

  // Set nsfw to true if the prompt contains nsfw words
  const isPromptNsfw = includesNsfw(params.prompt);
  params.nsfw ??= isPromptNsfw !== false;

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
  const resourcesToInject: typeof resourceData.injectable = [];
  for (const item of injectable) {
    const resource = resourceData.injectable.find((x) => x.id === item.id);
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
          [key as keyof TextToImageParams]: sanitized[key as keyof TextToImageParams],
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

  return {
    resources: [...availableResources, ...resourcesToInject],
    params: {
      ...params,
      quantity,
      batchSize,
      prompt: positivePrompts.join(', '),
      negativePrompt: negativePrompts.join(', '),
      // temp?
      upscaleWidth: getUpscaleSize(params.width, params.upscale),
      upscaleHeight: getUpscaleSize(params.height, params.upscale),
    },
  };
}

function getUpscaleSize(src: number, multiplier = 1) {
  return Math.ceil((src * multiplier) / 64) * 64;
}

function getResources(step: WorkflowStep) {
  if (step.$type === 'comfy') return (step as GeneratedImageWorkflowStep).metadata?.resources ?? [];
  else
    return getTextToImageAirs([(step as TextToImageStep).input]).map((x) => ({
      id: x.version,
      strength: x.networkParams.strength,
    }));
}

function combineResourcesWithInputResource(
  allResources: AirResourceData[],
  resources: { id: number; strength?: number | null }[]
) {
  return allResources.map((resource) => {
    const original = resources.find((x) => x.id === resource.id);
    const { settings = {} } = resource;
    settings.strength = original?.strength;
    resource.settings = settings;
    return resource;
  });
}

export type GeneratedImageResponseFormatted = AsyncReturnType<typeof formatGeneratedImageResponses>;
export async function formatGeneratedImageResponses(workflows: GeneratedImageWorkflow[]) {
  const steps = workflows.flatMap((x) => x.steps ?? []);
  const allResources = steps.flatMap(getResources);
  // console.dir(allResources, { depth: null });
  const versionIds = allResources.map((x) => x.id);
  const { resources, injectable } = await getResourceDataWithInjects(versionIds);

  return workflows.map((workflow) => {
    return {
      id: workflow.id as string,
      status: workflow.status ?? ('unassignend' as WorkflowStatus),
      createdAt: workflow.createdAt ? new Date(workflow.createdAt) : new Date(),
      totalCost:
        workflow.transactions?.list?.reduce((acc, value) => {
          if (value.type === 'debit') return acc + value.amount;
          else return acc - value.amount;
        }, 0) ?? 0,
      cost: workflow.cost,
      tags: workflow.tags ?? [],
      steps: workflow.steps.map((step) =>
        formatWorkflowStep({
          workflowId: workflow.id as string,
          step,
          resources: [...resources, ...injectable],
        })
      ),
    };
  });
}

// TODO - remove this 30 days after launch
function getTextToImageAirs(inputs: TextToImageInput[]) {
  return Object.entries(
    inputs.reduce<Record<string, ImageJobNetworkParams>>((acc, input) => {
      acc[input.model] = {};
      const additionalNetworks = input.additionalNetworks ?? {};
      for (const key in additionalNetworks) acc[key] = additionalNetworks[key];
      return acc;
    }, {})
  ).map(([air, networkParams]) => ({ ...parseAIR(air), networkParams }));
}

export type WorkflowStepFormatted = ReturnType<typeof formatWorkflowStep>;
function formatWorkflowStep(args: {
  workflowId: string;
  step: WorkflowStep;
  resources: AirResourceData[];
}) {
  const { step } = args;
  switch (step.$type) {
    case 'textToImage':
      return formatTextToImageStep(args);
    case 'comfy':
      return formatComfyStep(args);
    default:
      throw new Error('failed to extract generation resources: unsupported workflow type');
  }
}

export function formatTextToImageStep({
  step,
  resources: allResources,
  workflowId,
}: {
  step: WorkflowStep;
  resources: AirResourceData[];
  workflowId: string;
}) {
  const { input, output, jobs } = step as TextToImageStep;
  const metadata = (step.metadata ?? {}) as GeneratedImageStepMetadata;
  const {
    // resources: stepResources = [], // TODO - this should be ready to use in 30 days after launch
    params,
  } = metadata;
  const stepResources = getTextToImageAirs([input]);

  const resources = combineResourcesWithInputResource(allResources, getResources(step)).filter(
    (resource) => stepResources.some((x) => x.version === resource.id)
  );
  const versionIds = resources.map((x) => x.id);

  const checkpoint = resources.find((x) => x.model.type === 'Checkpoint');
  const baseModel = getBaseModelSetType(checkpoint?.baseModel);
  const injectable = getInjectablResources(baseModel);

  let prompt = input.prompt ?? '';
  let negativePrompt = input.negativePrompt ?? '';
  for (const item of Object.values(injectable).filter(isDefined)) {
    const resource = resources.find((x) => x.id === item.id);
    if (!resource) continue;
    const triggerWord = resource.trainedWords?.[0];
    if (triggerWord) {
      if (item?.triggerType === 'negative')
        negativePrompt = negativePrompt.replace(`${triggerWord}, `, '');
      if (item?.triggerType === 'positive') prompt = prompt.replace(`${triggerWord}, `, '');
    }
  }

  // infer draft from resources if not included in meta params
  const isDraft =
    metadata?.params?.draft ??
    (injectable.draft ? versionIds.includes(injectable.draft.id) : false);

  // infer nsfw from resources if not included in meta params
  const isNsfw = metadata?.params?.nsfw ?? !versionIds.includes(injectable.civit_nsfw.id);

  let quantity = input.quantity ?? 1;
  if (isDraft) {
    quantity *= 4;
  }

  const sampler =
    Object.entries(samplersToSchedulers).find(
      ([sampler, scheduler]) => scheduler.toLowerCase() === input.scheduler?.toLowerCase()
    )?.[0] ?? generation.defaultValues.sampler;

  const groupedImages = (jobs ?? []).reduce<Record<string, NormalizedGeneratedImage[]>>(
    (acc, job, i) => ({
      ...acc,
      [job.id]:
        output?.images
          ?.filter((x) => x.jobId === job.id)
          .map((image) => ({
            workflowId,
            stepName: step.name ?? '$0',
            jobId: job.id,
            id: image.id,
            status: image.available ? 'succeeded' : job.status ?? ('unassignend' as WorkflowStatus),
            seed: input.seed ? input.seed + i : undefined,
            completed: job.completedAt ? new Date(job.completedAt) : undefined,
            url: image.url as string,
          })) ?? [],
    }),
    {}
  );

  const images = Object.values(groupedImages).flat();

  const injectableIds = Object.values(injectable)
    .map((x) => x?.id)
    .filter(isDefined);

  return {
    $type: 'textToImage' as const,
    name: step.name,
    // TODO - after a month from deployment(?), we should be able to start using `step.metadata.params`
    // at that point in time, we can also make params and resources required properties on metadata to ensure that it doesn't get removed by step metadata updates
    params: {
      baseModel,
      prompt,
      negativePrompt,
      quantity,
      // controlNets: input.controlNets,
      // aspectRatio: getClosestAspectRatio(input.width, input.height, baseModel),

      width: input.width,
      height: input.height,
      seed: input.seed,
      draft: isDraft,
      nsfw: isNsfw,
      workflow: 'txt2img',
      //support using metadata params first (one of the quirks of draft mode makes this necessary)
      clipSkip: metadata?.params?.clipSkip ?? input.clipSkip ?? generation.defaultValues.clipSkip,
      steps: metadata?.params?.steps ?? input.steps ?? generation.defaultValues.steps,
      cfgScale: metadata?.params?.cfgScale ?? input.cfgScale ?? generation.defaultValues.cfgScale,
      sampler: metadata?.params?.sampler ?? sampler ?? generation.defaultValues.sampler,
    } as TextToImageParams,
    images,
    status: step.status,
    metadata: metadata,
    resources: formatGenerationResources(resources.filter((x) => !injectableIds.includes(x.id))),
  };
}

export function formatComfyStep({
  step,
  resources,
  workflowId,
}: {
  step: WorkflowStep;
  resources: AirResourceData[];
  workflowId: string;
}) {
  const { output, jobs, metadata = {} } = step as ComfyStep;
  const { resources: stepResources = [], params } = metadata as GeneratedImageStepMetadata;

  const groupedImages = (jobs ?? []).reduce<Record<string, NormalizedGeneratedImage[]>>(
    (acc, job, i) => ({
      ...acc,
      [job.id]:
        output?.blobs
          ?.filter((x) => x.jobId === job.id)
          .map((image) => ({
            workflowId,
            stepName: step.name ?? '$0',
            jobId: job.id,
            id: image.id,
            status: image.available ? 'succeeded' : job.status ?? ('unassignend' as WorkflowStatus),
            seed: params?.seed ? params.seed + i : undefined,
            completed: job.completedAt ? new Date(job.completedAt) : undefined,
            url: image.url as string,
          })) ?? [],
    }),
    {}
  );

  const images = Object.values(groupedImages).flat();

  if (params?.aspectRatio) {
    const size = getSizeFromAspectRatio(Number(params.aspectRatio), params?.baseModel);
    params.width = size.width;
    params.height = size.height;
  }

  return {
    $type: 'comfy' as const,
    name: step.name,
    params: { ...params! } as TextToImageParams,
    images,
    status: step.status,
    metadata: metadata as GeneratedImageStepMetadata,
    resources: formatGenerationResources(
      combineResourcesWithInputResource(resources, stepResources).filter((resource) =>
        stepResources.some((x) => x.id === resource.id)
      )
    ),
  };
}

export type GeneratedImageWorkflowModel = AsyncReturnType<
  typeof queryGeneratedImageWorkflows
>['items'][0];
export async function queryGeneratedImageWorkflows(
  props: Parameters<typeof queryWorkflows>[0] & { token: string }
) {
  const { nextCursor, items } = await queryWorkflows({
    ...props,
    tags: [WORKFLOW_TAGS.IMAGE, ...(props.tags ?? [])],
  });

  return {
    items: await formatGeneratedImageResponses(items as GeneratedImageWorkflow[]),
    nextCursor,
  };
}
