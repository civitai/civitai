import {
  ComfyStep,
  createCivitaiClient,
  HaiperVideoGenOutput,
  ImageJobNetworkParams,
  Priority,
  TextToImageInput,
  TextToImageStep,
  VideoBlob,
  VideoGenStep,
  Workflow,
  WorkflowStatus,
  WorkflowStep,
} from '@civitai/client';
import type { SessionUser } from 'next-auth';
import { z } from 'zod';
import { env } from '~/env/server';
import { generation } from '~/server/common/constants';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { VideoGenerationSchema } from '~/server/orchestrator/generation/generation.config';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { GenerationStatus, generationStatusSchema } from '~/server/schema/generation.schema';
import {
  GeneratedImageStepMetadata,
  generateImageSchema,
  TextToImageParams,
} from '~/server/schema/orchestrator/textToImage.schema';
import { UserTier } from '~/server/schema/user.schema';
import {
  GenerationResource,
  getGenerationResourceData,
} from '~/server/services/generation/generation.service';
import { NormalizedGeneratedImage } from '~/server/services/orchestrator';
import {
  GeneratedImageWorkflow,
  GeneratedImageWorkflowStep,
  WorkflowDefinition,
} from '~/server/services/orchestrator/types';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import {
  allInjectableResourceIds,
  fluxModeOptions,
  fluxUltraAir,
  fluxUltraAirId,
  getBaseModelResourceTypes,
  getBaseModelSetType,
  getInjectablResources,
  getIsFlux,
  getIsSD3,
  getRoundedUpscaleSize,
  getSizeFromAspectRatio,
  InjectableResource,
  samplersToSchedulers,
  sanitizeParamsByWorkflowDefinition,
  sanitizeTextToImageParams,
} from '~/shared/constants/generation.constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { removeEmpty } from '~/utils/object-helpers';
import { parseAIR } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

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
    JSON.parse(
      (await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.GENERATION.STATUS)) ??
        '{}'
    )
  );

  return status as GenerationStatus;
}

// TODO - pass user data
export async function getResourceDataWithInjects<T extends GenerationResource>(args: {
  ids: number[];
  user?: SessionUser;
  cb?: (resource: GenerationResource) => T;
}) {
  const ids = [...args.ids, ...allInjectableResourceIds];
  const results = await getGenerationResourceData({ ids, user: args.user });
  const allResources = (args.cb ? results.map(args.cb) : results) as T[];

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
  whatIf,
}: z.infer<typeof generateImageSchema> & {
  user: SessionUser;
  workflowDefinition: WorkflowDefinition;
  whatIf?: boolean;
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
    if (originalParams.fluxMode === fluxUltraAir) {
      delete originalParams.steps;
      delete originalParams.cfgScale;
      delete originalParams.negativePrompt;
      delete originalParams.clipSkip;
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

  const resourceData = await getResourceDataWithInjects({
    ids: originalResources.map((x) => x.id),
    user,
    cb: (resource) => ({
      ...resource,
      ...originalResources.find((x) => x.id === resource.id),
      triggerWord: resource.trainedWords?.[0],
    }),
  });

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
  if (!resourceData.resources.every((x) => x.canGenerate) && params.workflow !== 'img2img-upscale')
    throw throwBadRequestError(
      `Some of your resources are not available for generation: ${resourceData.resources
        .filter((x) => !x.canGenerate)
        .map((x) => x.name)
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
  if (params.aspectRatio && (!params.width || !params.height)) {
    const size = getSizeFromAspectRatio(Number(params.aspectRatio), params.baseModel);
    params.width = size.width;
    params.height = size.height;
  }

  // this needs to come after updating the size from the aspect ratio that is done directly above
  params = sanitizeTextToImageParams(params, limits);
  // #endregion

  // handle moderate prompt
  if (!whatIf) {
    const moderationResult = await extModeration.moderatePrompt(params.prompt).catch((error) => {
      logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
      return { flagged: false, categories: [] as string[] };
    });

    if (moderationResult.flagged) {
      throw throwBadRequestError(
        `Your prompt was flagged for: ${moderationResult.categories.join(', ')}`
      );
    }
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
  if (!whatIf) {
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
  }

  let quantity = params.quantity;
  let batchSize = 1;
  if (params.draft) {
    quantity = Math.ceil(params.quantity / 4);
    batchSize = 4;
    params.sampler = 'LCM';
  }

  if (!params.upscaleHeight || !params.upscaleWidth) {
    params.upscaleHeight = params.height * 1.5;
    params.upscaleWidth = params.width * 1.5;
  }

  const upscale =
    params.upscaleHeight && params.upscaleWidth
      ? getRoundedUpscaleSize({ width: params.upscaleWidth, height: params.upscaleHeight })
      : undefined;

  return {
    resources: [...availableResources, ...resourcesToInject],
    params: removeEmpty({
      ...params,
      quantity,
      batchSize,
      prompt: positivePrompts.join(', '),
      negativePrompt: negativePrompts.join(', '),
      // temp?
      upscaleWidth: upscale?.width,
      upscaleHeight: upscale?.height,
    }),
    // priority: getUserPriority(status, user),
  };
}

function getResources(step: WorkflowStep) {
  if (step.$type === 'textToImage')
    return getTextToImageAirs([(step as TextToImageStep).input]).map((x) => ({
      id: x.version,
      strength: x.networkParams.strength,
    }));
  return (step as GeneratedImageWorkflowStep).metadata?.resources ?? [];
}

function getTextToImageAirs(inputs: TextToImageInput[]) {
  return Object.entries(
    inputs.reduce<Record<string, ImageJobNetworkParams>>((acc, input) => {
      if (input.model) acc[input.model] = {};
      const additionalNetworks = input.additionalNetworks ?? {};
      for (const key in additionalNetworks) acc[key] = additionalNetworks[key];
      return acc;
    }, {})
  ).map(([air, networkParams]) => ({ ...parseAIR(air), networkParams }));
}

function combineResourcesWithInputResource(
  allResources: GenerationResource[],
  resources: { id: number; strength?: number | null }[]
) {
  return allResources
    .map((resource) => {
      const original = resources.find((x) => x.id === resource.id);
      if (!original) return null;
      return { ...resource, strength: original.strength ?? resource.strength };
    })
    .filter(isDefined);
}

export async function formatGenerationResponse(workflows: Workflow[], user?: SessionUser) {
  const steps = workflows.flatMap((x) => x.steps ?? []);
  const allResources = steps.flatMap(getResources);
  // console.dir(allResources, { depth: null });
  const versionIds = allResources.map((x) => x.id);
  const { resources, injectable } = await getResourceDataWithInjects({ ids: versionIds, user });

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
          // ensure that job status is set to 'succeeded' if workflow status is set to 'succeedeed'
          step: workflow.status === 'succeeded' ? { ...step, status: workflow.status } : step,
          resources: [...resources, ...injectable],
        })
      ),
    };
  });
}

// // TODO - remove this 30 days after launch
// function getTextToImageAirs(inputs: TextToImageInput[]) {
//   return Object.entries(
//     inputs.reduce<Record<string, ImageJobNetworkParams>>((acc, input) => {
//       if (input.model) acc[input.model] = {};
//       const additionalNetworks = input.additionalNetworks ?? {};
//       for (const key in additionalNetworks) acc[key] = additionalNetworks[key];
//       return acc;
//     }, {})
//   ).map(([air, networkParams]) => ({ ...parseAIR(air), networkParams }));
// }

export type WorkflowStepFormatted = ReturnType<typeof formatWorkflowStep>;
function formatWorkflowStep(args: {
  workflowId: string;
  step: WorkflowStep;
  resources: GenerationResource[];
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
  const { params } = videoMetadata;

  let width: number | undefined;
  let height: number | undefined;
  let aspectRatio = 1;

  if (params) {
    if (params.type === 'img2vid') {
      width = params?.width;
      height = params?.height;
      aspectRatio = width && height ? width / height : 16 / 9;
    } else if (params.type === 'txt2vid') {
      switch (params.engine) {
        case 'lightricks':
        case 'kling':
        case 'haiper': {
          if (params.aspectRatio) {
            const [rw, rh] = params.aspectRatio.split(':').map(Number);
            aspectRatio = rw / rh;
          }
          break;
        }
        case 'minimax':
          aspectRatio = 16 / 9;
          break;
        case 'mochi':
          width = 848;
          height = 480;
          aspectRatio = width / height;
          break;
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
            reason: (output as HaiperVideoGenOutput).message ?? undefined,
            seed: (input as any).seed, // TODO - determine if seed should be a common videoGen prop
            completed: job.completedAt ? new Date(job.completedAt) : undefined,
            url: image.url + '.mp4',
            width: width ?? 1080,
            height: height ?? 1080,
            queuePosition: job.queuePosition,
            aspectRatio,
          })) ?? [],
    }),
    {}
  );
  const videos = Object.values(grouped).flat();
  const metadata = (step.metadata ?? {}) as GeneratedImageStepMetadata;
  // need to get sourceImage from original input due to orchestrator not always returning sourceImage in the step input - 01/18/2025
  const sourceImage =
    params && 'sourceImage' in params ? (params.sourceImage as string) : undefined;

  // TODO - this should be temporary until Koen updates the orchestrator - 12/11/2024
  if (
    input.engine === 'kling' &&
    (sourceImage || (input as any).sourceImage || (input as any).sourceImageUrl)
  ) {
    if ('aspectRatio' in input) delete input.aspectRatio;
  }

  return {
    $type: 'videoGen' as const,
    timeout: step.timeout,
    name: step.name,
    // workflow and quantity are only here because they are required for other components to function
    params: {
      ...input,
      sourceImage: sourceImage ?? (input as any).sourceImage ?? (input as any).sourceImageUrl,
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
  resources?: GenerationResource[];
  workflowId: string;
}) {
  const { input, output, jobs } = step as TextToImageStep;
  const metadata = (step.metadata ?? {}) as GeneratedImageStepMetadata;
  const stepResources = getResources(step);

  const resources = combineResourcesWithInputResource(allResources, stepResources);
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
        // while (negativePrompt.startsWith(triggerWord)) {
        negativePrompt = negativePrompt.replace(`${triggerWord}, `, '');
      // }
      if (item?.triggerType === 'positive')
        // while (prompt.startsWith(triggerWord)) {
        prompt = prompt.replace(`${triggerWord}, `, '');
      // }
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
            width: input.width,
            height: input.height,
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

  const params = {
    baseModel,
    prompt,
    negativePrompt,
    quantity,
    engine: input.engine,
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

    fluxMode: metadata?.params?.fluxMode ?? undefined,
    fluxUltraRaw: input.engine === 'flux-pro-raw' ? true : undefined,
  } as TextToImageParams;

  if (resources.some((x) => x.id === fluxUltraAirId)) {
    delete params.steps;
    delete params.cfgScale;
    delete params.clipSkip;
    delete (params as any).draft;
    delete (params as any).nsfw;
  }

  return {
    $type: 'textToImage' as const,
    timeout: step.timeout,
    name: step.name,
    // TODO - after a month from deployment(?), we should be able to start using `step.metadata.params`
    // at that point in time, we can also make params and resources required properties on metadata to ensure that it doesn't get removed by step metadata updates
    params,
    images,
    status: step.status,
    metadata: metadata,
    resources: resources.filter((x) => !injectableIds.includes(x.id)),
  };
}

export function formatComfyStep({
  step,
  resources = [],
  workflowId,
}: {
  step: WorkflowStep;
  resources?: GenerationResource[];
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
            width: params?.width ?? 512,
            height: params?.height ?? 512,
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

  const data = { ...params!, ...upscale } as TextToImageParams;
  // if(data.workflow === 'img2img-upscale"') {
  //   delete (data as any).nsfw;
  //   delete (data as any).
  // }

  return {
    $type: 'comfy' as const,
    timeout: step.timeout,
    name: step.name,
    params: data,
    images,
    status: step.status,
    metadata: metadata as GeneratedImageStepMetadata,
    resources: combineResourcesWithInputResource(resources, stepResources),
  };
}

export type GeneratedImageWorkflowModel = AsyncReturnType<
  typeof queryGeneratedImageWorkflows
>['items'][0];
export async function queryGeneratedImageWorkflows({
  user,
  ...props
}: Parameters<typeof queryWorkflows>[0] & { token: string; user?: SessionUser }) {
  const { nextCursor, items } = await queryWorkflows(props);

  return {
    items: await formatGenerationResponse(items as GeneratedImageWorkflow[], user),
    nextCursor,
  };
}

const MEMBERSHIP_PRIORITY: Record<UserTier, Priority> = {
  free: Priority.LOW,
  founder: Priority.NORMAL,
  bronze: Priority.NORMAL,
  silver: Priority.NORMAL,
  gold: Priority.HIGH,
};
export function getUserPriority(status: GenerationStatus, user: { tier?: UserTier }) {
  if (!status.membershipPriority) return Priority.NORMAL;
  return MEMBERSHIP_PRIORITY[user.tier ?? 'free'];
}
