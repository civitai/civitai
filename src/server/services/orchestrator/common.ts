import {
  Blob,
  ComfyStep,
  HaiperVideoGenInput,
  HaiperVideoGenOutput,
  ImageJobNetworkParams,
  TextToImageInput,
  TextToImageStep,
  VideoBlob,
  VideoGenOutput,
  VideoGenStep,
  Workflow,
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
  fluxModeOptions,
  formatGenerationResources,
  getBaseModelResourceTypes,
  getBaseModelSetType,
  getInjectablResources,
  getIsFlux,
  getIsSD3,
  getRoundedUpscaleSize,
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
import { generation } from '~/server/common/constants';
import { SessionUser } from 'next-auth';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { z } from 'zod';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { ModelType } from '@prisma/client';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { NormalizedGeneratedImage } from '~/server/services/orchestrator';
import { VideoGenerationSchema } from '~/server/schema/orchestrator/orchestrator.schema';

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

  // Handle Flux Mode
  const isFlux = getIsFlux(originalParams.baseModel);
  if (isFlux && originalParams.fluxMode) {
    // const { version } = parseAIR(originalParams.fluxMode);
    originalParams.sampler = 'undefined';
    // originalResources = [{ id: version, strength: 1 }];
    originalParams.nsfw = true; // No nsfw helpers in flux mode
    originalParams.draft = false;
    originalParams.negativePrompt = '';
    delete originalParams.clipSkip;
    if (originalParams.fluxMode === fluxModeOptions[0].value) {
      originalParams.steps = 4;
      originalParams.cfgScale = 1;
    }
  } else {
    originalParams.fluxMode = undefined;
  }

  const isSD3 = getIsSD3(originalParams.baseModel);
  if (isSD3) {
    originalParams.sampler = 'undefined';
    originalParams.nsfw = true; // No nsfw helpers in SD3
    originalParams.draft = false;
    if (originalResources.find((x) => x.id === 983611)) {
      originalParams.steps = 4;
      originalParams.cfgScale = 1;
    }
  }

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

  const model = resourceData.resources.find(
    (x) => x.model.type === ModelType.Checkpoint || x.model.type === ModelType.Upscaler
  );
  if (!model) throw throwBadRequestError('A checkpoint is required to make a generation request');
  if (params.baseModel !== getBaseModelSetType(model.baseModel))
    throw throwBadRequestError(
      `Invalid base model. Checkpoint with baseModel: ${model.baseModel} does not match the input baseModel: ${params.baseModel}`
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

  const availableResourceTypes =
    getBaseModelResourceTypes(params.baseModel)?.map((x) => x.type) ?? [];
  // const availableResourceTypes = config.additionalResourceTypes.map((x) => x.type);
  const availableResources = [
    model,
    ...resourceData.resources.filter((x) => availableResourceTypes.includes(x.model.type as any)),
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
  if (!isFlux && !isSD3) {
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

  if (!params.upscaleHeight || !params.upscaleWidth) {
    params.upscaleHeight = params.height * 1.5;
    params.upscaleWidth = params.width * 1.5;
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
      ...(params.upscaleHeight && params.upscaleWidth
        ? getRoundedUpscaleSize({ width: params.upscaleWidth, height: params.upscaleHeight })
        : {}),
    },
  };
}

function getResources(step: WorkflowStep) {
  if (step.$type === 'comfy') return (step as GeneratedImageWorkflowStep).metadata?.resources ?? [];
  else if (step.$type === 'textToImage')
    return getTextToImageAirs([(step as TextToImageStep).input]).map((x) => ({
      id: x.version,
      strength: x.networkParams.strength,
    }));
  else return [];
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

export async function formatGenerationResponse(workflows: Workflow[]) {
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
      steps: (workflow.steps ?? [])?.map((step) =>
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
    case 'videoGen':
      return formatVideoGenStep(args);
    default:
      throw new Error('failed to extract generation resources: unsupported workflow type');
  }
}

function formatVideoGenStep({ step, workflowId }: { step: WorkflowStep; workflowId: string }) {
  const { input, output, jobs } = step as VideoGenStep;
  const videoMetadata = step.metadata as { params?: VideoGenerationSchema };

  let width = videoMetadata.params?.width;
  let height = videoMetadata.params?.height;

  // if ((workflowId = '0-20241108234000287')) console.log(input);

  const { params } = videoMetadata;
  if (params) {
    switch (params.engine) {
      case 'haiper': {
        const { aspectRatio, resolution } = params;
        if (aspectRatio && resolution && (!width || !height)) {
          const [rw, rh] = aspectRatio.split(':').map(Number);
          width = resolution;
          const ratio = width / rw;
          height = ratio * rh;
        }
      }
    }
  }

  const grouped = (jobs ?? []).reduce<Record<string, NormalizedGeneratedImage[]>>(
    (acc, job, i) => ({
      ...acc,
      [job.id]:
        [output?.video as VideoBlob]
          ?.filter(isDefined)
          .filter((x) => x.jobId === job.id)
          .map((image) => ({
            type: 'video',
            progress: (output as HaiperVideoGenOutput).progress ?? 0,
            workflowId,
            stepName: step.name,
            jobId: job.id,
            id: image.id,
            status: image.available ? 'succeeded' : job.status ?? ('unassignend' as WorkflowStatus),
            seed: (input as any).seed, // TODO - determine if seed should be a common videoGen prop
            completed: job.completedAt ? new Date(job.completedAt) : undefined,
            url: image.url + '.mp4',
            width: width ?? 1080,
            height: height ?? 1080,
          })) ?? [],
    }),
    {}
  );
  const videos = Object.values(grouped).flat();
  const metadata = (step.metadata ?? {}) as GeneratedImageStepMetadata;

  return {
    $type: 'videoGen' as const,
    timeout: step.timeout,
    name: step.name,
    // workflow and quantity are only here because they are required for other components to function
    params: {
      ...input,
      workflow: videoMetadata.params?.workflow,
      quantity: 1,
    },
    images: videos,
    status: step.status,
    metadata,
    resources: [],
  };
}

function formatTextToImageStep({
  step,
  resources: allResources = [],
  workflowId,
}: {
  step: WorkflowStep;
  resources?: AirResourceData[];
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
            type: 'image',
            workflowId,
            stepName: step.name,
            jobId: job.id,
            id: image.id,
            status: image.available ? 'succeeded' : job.status ?? ('unassignend' as WorkflowStatus),
            seed: input.seed ? input.seed + i : undefined,
            completed: job.completedAt ? new Date(job.completedAt) : undefined,
            url: image.url as string,
            height: input.height,
            width: input.width,
          })) ?? [],
    }),
    {}
  );

  const images = Object.values(groupedImages).flat();

  const injectableIds = Object.values(injectable)
    .map((x) => x?.id)
    .filter(isDefined);

  const upscale =
    'upscale' in input
      ? {
          upscaleWidth: input.width * (input.upscale as number),
          upscaleHeight: input.height * (input.upscale as number),
        }
      : {};

  return {
    $type: 'textToImage' as const,
    timeout: step.timeout,
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
      clipSkip: metadata?.params?.clipSkip ?? input.clipSkip,
      steps: metadata?.params?.steps ?? input.steps,
      cfgScale: metadata?.params?.cfgScale ?? input.cfgScale,
      sampler: metadata?.params?.sampler ?? sampler,
      ...upscale,

      fluxMode: metadata?.params?.fluxMode,
    } as TextToImageParams,
    images,
    status: step.status,
    metadata: metadata,
    resources: formatGenerationResources(resources.filter((x) => !injectableIds.includes(x.id))),
  };
}

export function formatComfyStep({
  step,
  resources = [],
  workflowId,
}: {
  step: WorkflowStep;
  resources?: AirResourceData[];
  workflowId: string;
}) {
  const { output, jobs, metadata = {} } = step as ComfyStep;
  const { resources: stepResources = [], params } = metadata as GeneratedImageStepMetadata;

  if (params?.aspectRatio) {
    const size = getSizeFromAspectRatio(Number(params.aspectRatio), params?.baseModel);
    params.width = size.width;
    params.height = size.height;
  }

  const groupedImages = (jobs ?? []).reduce<Record<string, NormalizedGeneratedImage[]>>(
    (acc, job, i) => ({
      ...acc,
      [job.id]:
        output?.blobs
          ?.filter((x) => x.jobId === job.id)
          .map((image) => ({
            type: 'image',
            workflowId,
            stepName: step.name,

            jobId: job.id,
            id: image.id,
            status: image.available ? 'succeeded' : job.status ?? ('unassignend' as WorkflowStatus),
            seed: params?.seed ? params.seed + i : undefined,
            completed: job.completedAt ? new Date(job.completedAt) : undefined,
            url: image.url as string,
            height: params?.height ?? 512,
            width: params?.width ?? 512,
          })) ?? [],
    }),
    {}
  );

  const images = Object.values(groupedImages).flat();

  const upscale =
    params && 'upscale' in params
      ? {
          upscaleWidth: params.width * (params.upscale as number),
          upscaleHeight: params.height * (params.upscale as number),
        }
      : {};

  return {
    $type: 'comfy' as const,
    timeout: step.timeout,
    name: step.name,
    params: { ...params!, ...upscale } as TextToImageParams,
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
  const { nextCursor, items } = await queryWorkflows(props);

  return {
    items: await formatGenerationResponse(items as GeneratedImageWorkflow[]),
    nextCursor,
  };
}
