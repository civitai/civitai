import {
  ComfyStep,
  ImageJobNetworkParams,
  TextToImageInput,
  TextToImageStep,
  WorkflowStatus,
  WorkflowStep,
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
  getWorkflowDefinitionFeatures,
  samplersToSchedulers,
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
import { GeneratedImageWorkflow, WorkflowDefinition } from '~/server/services/orchestrator/types';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { getGenerationConfig } from '~/server/common/constants';
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

export async function parseGenerateImageInput({
  user,
  params: originalParams,
  resources,
  workflowDefinition,
}: z.infer<typeof generateImageSchema> & {
  user: SessionUser;
  workflowDefinition: WorkflowDefinition;
}) {
  let params = { ...originalParams };
  const status = await getGenerationStatus();
  const limits = status.limits[user.tier ?? 'free'];

  if (!status.available && !user.isModerator)
    throw throwBadRequestError('Generation is currently disabled');

  if (resources.length > limits.resources)
    throw throwBadRequestError('You have exceed the number of allowed resources.');

  const resourceData = await getResourceDataWithInjects(
    resources.map((x) => x.id),
    (resource) => ({
      ...resource,
      ...resources.find((x) => x.id === resource.id),
      triggerWord: resource.trainedWords?.[0],
    })
  );

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
  if (!resourceData.resources.every((x) => !!x.covered))
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

  const { width, height } = getSizeFromAspectRatio(Number(params.aspectRatio), params.baseModel);

  return {
    resources: [...availableResources, ...resourcesToInject],
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
      // temp?
      upscaleWidth: getUpscaleSize(width, params.upscale),
      upscaleHeight: getUpscaleSize(height, params.upscale),
    },
  };
}

function getUpscaleSize(src: number, multiplier = 1) {
  return Math.ceil((src * multiplier) / 64) * 64;
}

function getStepCost(step: WorkflowStep) {
  return step.jobs ? Math.ceil(step.jobs.reduce((acc, job) => acc + (job.cost ?? 0), 0)) : 0;
}

export async function formatGeneratedImageResponses(workflows: GeneratedImageWorkflow[]) {
  const steps = workflows.flatMap((x) => x.steps ?? []);
  const versionIds = steps.flatMap((step) => {
    if (step.$type === 'comfy') return step.metadata?.resources?.map((r) => r.id) ?? [];
    else return getTextToImageAirs([(step as TextToImageStep).input]).map((x) => x.version);
  });
  const { resources, injectable } = await getResourceDataWithInjects(versionIds);

  return workflows.map((workflow) => {
    return {
      id: workflow.id as string,
      status: workflow.status ?? ('unassignend' as WorkflowStatus),
      createdAt: workflow.createdAt ? new Date(workflow.createdAt) : new Date(),
      totalCost:
        workflow.transactions?.reduce((acc, transaction) => acc + transaction.amount, 0) ?? 0,
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

  const resources = allResources.filter((resource) =>
    stepResources.some((x) => x.version === resource.id)
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

  const sampler = Object.entries(samplersToSchedulers).find(
    ([sampler, scheduler]) => scheduler.toLowerCase() === input.scheduler?.toLowerCase()
  )?.[0];

  const images: NormalizedGeneratedImage[] =
    output?.images
      ?.map((image, i) => {
        const seed = input.seed;
        const job = jobs?.find((x) => x.id === image.jobId);
        if (!job) return null;
        return {
          workflowId,
          stepName: step.name ?? '$0',
          jobId: job.id,
          id: image.id,
          status: job.status ?? ('unassignend' as WorkflowStatus),
          seed: seed ? seed + i : undefined,
          completed: job.completedAt ? new Date(job.completedAt) : undefined,
          url: image.url as string,
        };
      })
      .filter(isDefined) ?? [];

  const injectableIds = Object.values(injectable)
    .map((x) => x?.id)
    .filter(isDefined);

  return {
    $type: 'textToImage' as const,
    name: step.name,
    // TODO - after a month from deployment(?), we should be able to start using `step.metadata.params`
    // at that point in time, we can also make params and resources required properties on metadata to ensure that it doesn't get removed by step metadata updates
    params: {
      ...params,
      baseModel,
      prompt,
      negativePrompt,
      quantity,
      controlNets: input.controlNets,
      sampler,
      steps: input.steps,
      cfgScale: input.cfgScale,
      width: input.width,
      height: input.height,
      seed: input.seed,
      clipSkip: input.clipSkip,
      draft: isDraft,
      nsfw: isNsfw,
      workflow: 'txt2img',
    },
    images,
    status: step.status,
    metadata: metadata,
    resources: formatGenerationResources(resources.filter((x) => !injectableIds.includes(x.id))),
    cost: getStepCost(step),
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
  const { input, output, jobs, metadata = {} } = step as ComfyStep;
  const { resources: stepResources = [], params } = metadata as GeneratedImageStepMetadata;

  const images: NormalizedGeneratedImage[] =
    output?.blobs
      ?.map((image, i) => {
        const seed = (input as any).seed;
        const job = jobs?.find((x) => x.id === image.jobId);
        if (!job) return null;
        return {
          workflowId,
          stepName: step.name,
          jobId: job.id,
          id: image.id,
          status: job.status ?? ('unassignend' as WorkflowStatus),
          seed: seed ? seed + i : undefined,
          completed: job.completedAt ? new Date(job.completedAt) : undefined,
          url: image.url as string,
        };
      })
      .filter(isDefined) ?? [];

  return {
    $type: 'comfy' as const,
    name: step.name,
    params: params!,
    images,
    status: step.status,
    metadata: metadata as GeneratedImageStepMetadata,
    resources: formatGenerationResources(
      resources.filter((resource) => stepResources.some((x) => x.id === resource.id))
    ),
    cost: getStepCost(step),
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
