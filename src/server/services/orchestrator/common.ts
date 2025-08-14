import type {
  ComfyStep,
  HaiperVideoGenOutput,
  ImageGenStep,
  TextToImageStep,
  VideoBlob,
  VideoGenStep,
  Workflow,
  WorkflowStatus,
  WorkflowStep,
} from '@civitai/client';
import {
  createCivitaiClient,
  ImageJobNetworkParams,
  Priority,
  TextToImageInput,
} from '@civitai/client';
import { uniq, uniqBy } from 'lodash-es';
import type { SessionUser } from 'next-auth';
import type * as z from 'zod';
import { env } from '~/env/server';
import { generation } from '~/server/common/constants';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { type VideoGenerationSchema2 } from '~/server/orchestrator/generation/generation.config';
import { wanBaseModelMap } from '~/server/orchestrator/wan/wan.schema';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { GenerationStatus } from '~/server/schema/generation.schema';
import { generationStatusSchema } from '~/server/schema/generation.schema';
import type {
  GeneratedImageStepMetadata,
  generateImageSchema,
  TextToImageParams,
} from '~/server/schema/orchestrator/textToImage.schema';
import type { UserTier } from '~/server/schema/user.schema';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { getResourceData } from '~/server/services/generation/generation.service';
import type { NormalizedGeneratedImage } from '~/server/services/orchestrator';
import type {
  GeneratedImageWorkflow,
  WorkflowDefinition,
} from '~/server/services/orchestrator/types';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { getUserSubscription } from '~/server/services/subscriptions.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type { InjectableResource } from '~/shared/constants/generation.constants';
import {
  allInjectableResourceIds,
  fluxDraftAir,
  fluxModeOptions,
  fluxModelId,
  fluxUltraAir,
  fluxUltraAirId,
  getBaseModelFromResources,
  getBaseModelFromResourcesWithDefault,
  getBaseModelSetType,
  getInjectablResources,
  getIsFlux,
  getIsFluxStandard,
  getIsSD3,
  getRoundedWidthHeight,
  samplersToSchedulers,
  sanitizeParamsByWorkflowDefinition,
  sanitizeTextToImageParams,
} from '~/shared/constants/generation.constants';
import { hiDreamModelId } from '~/shared/orchestrator/hidream.config';
import { Availability, ModelType } from '~/shared/utils/prisma/enums';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { removeEmpty } from '~/utils/object-helpers';
import { parseAIR, stringifyAIR } from '~/shared/utils/air';
import { isDefined } from '~/utils/type-guards';
import { getGenerationBaseModelResourceOptions } from '~/shared/constants/base-model.constants';

export function createOrchestratorClient(token: string) {
  return createCivitaiClient({
    baseUrl: env.ORCHESTRATOR_ENDPOINT,
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
type TrueGenerationData = AsyncReturnType<typeof getResourceData>[number];
export async function getResourceDataWithInjects<T extends TrueGenerationData>(
  versions: { id: number; epoch?: number }[],
  user?: SessionUser,
  cb?: (resource: TrueGenerationData) => T
) {
  const results = await getResourceData(
    [...versions, ...allInjectableResourceIds.map((id) => ({ id }))],
    user,
    true
  );

  const allResources = (cb ? results.map(cb) : results) as T[];

  const resources = allResources.filter((x) => !allInjectableResourceIds.includes(x.id));
  const injectable = allResources.filter((x) => allInjectableResourceIds.includes(x.id));

  return {
    resources,
    injectable,
  };
}

export async function getGenerationStatusLimits(user?: SessionUser) {
  const status = await getGenerationStatus();
  if (!status.available && !user?.isModerator)
    throw throwBadRequestError('Generation is currently disabled');

  return status.limits[user?.tier ?? 'free'];
}

export async function getGenerationResourceData(
  versions: { id: number; strength: number; epochNumber?: number }[],
  limit: number,
  user?: SessionUser
) {
  const { resources, injectable } = await getResourceDataWithInjects(
    versions.map(({ id, epochNumber }) => ({ id, epoch: epochNumber })),
    user,
    (resource) => ({
      ...resource,
      ...versions.find((x) => x.id === resource.id),
      triggerWord: resource.trainedWords?.[0],
    })
  );

  if (
    user &&
    !user.isModerator &&
    resources.some(
      (r) => r.availability === Availability.Private || !!r.epochDetails || !!r.epochNumber
    )
  ) {
    // Confirm the user has a subscription:
    const subscription = await getUserSubscription({ userId: user.id });
    if (!subscription)
      throw throwBadRequestError('Using Private resources require an active subscription.');
  }

  if (resources.some((x) => x.epochDetails && x.epochDetails.isExpired)) {
    throw throwBadRequestError(
      'One of the epochs you are trying to generate with has expired. Make it a private model to continue using it.'
    );
  }

  // handle missing coverage
  if (!resources.every((x) => x.canGenerate))
    throw throwBadRequestError(
      `Some of your resources are not available for generation: ${resources
        .filter((x) => !x.canGenerate)
        .map((x) => x.name)
        .join(', ')}`
    );

  const baseModel = await getBaseModelFromResourcesWithDefault(
    resources.map((r) => ({ baseModel: r.baseModel, modelType: r.model.type }))
  );

  // remove any resources that may not be supported by the generator
  const availableResourceTypes =
    getGenerationBaseModelResourceOptions(baseModel)?.map((x) => x.type) ?? [];
  const availableResources = resources.filter((x) =>
    availableResourceTypes.includes(x.model.type as any)
  );

  const hasMinorResource = availableResources.some((x) => x.model.minor);
  const hasPoiResource = availableResources.some((x) => x.model.poi);

  const model = availableResources.find(
    (x) => x.model.type === 'Checkpoint' || x.model.type === 'Upscaler'
  );
  const vae = availableResources.find((x) => x.model.type === 'VAE');
  const additionalResources = availableResources.filter(
    (x) => x.model.type !== 'Checkpoint' && x.model.type !== 'VAE'
  );

  if (additionalResources.length > limit)
    throw throwBadRequestError('You have exceed the number of allowed resources.');

  return { model, vae, additionalResources, injectable, hasMinorResource, hasPoiResource };
}

export async function parseGenerateImageInput({
  user,
  params: originalParams,
  resources: originalResources,
  workflowDefinition,
  whatIf,
  batchAll,
}: z.infer<typeof generateImageSchema> & {
  user: SessionUser;
  workflowDefinition: WorkflowDefinition;
  whatIf?: boolean;
  batchAll?: boolean;
}) {
  delete originalParams.openAITransparentBackground;
  delete originalParams.openAIQuality;
  if (originalParams.workflow.startsWith('txt2img')) originalParams.sourceImage = null;
  // remove data not allowed by workflow features
  sanitizeParamsByWorkflowDefinition(originalParams, workflowDefinition);
  if (originalParams.sourceImage) {
    originalParams.width = originalParams.sourceImage.width;
    originalParams.height = originalParams.sourceImage.height;
    originalParams.upscaleWidth = originalParams.sourceImage.upscaleWidth;
    originalParams.upscaleHeight = originalParams.sourceImage.upscaleHeight;
  }

  // Handle Flux Mode
  const isFlux = getIsFlux(originalParams.baseModel);
  if (isFlux) {
    // const { version } = parseAIR(originalParams.fluxMode);
    originalParams.sampler = 'undefined';
    // originalResources = [{ id: version, strength: 1 }];
    originalParams.draft = false;
    originalParams.negativePrompt = '';
    delete originalParams.clipSkip;
    if (originalParams.fluxMode === fluxDraftAir) {
      originalParams.steps = 4;
      originalParams.cfgScale = 1;
    }
    if (originalParams.fluxMode === fluxUltraAir) {
      delete originalParams.steps;
      delete originalParams.cfgScale;
      delete originalParams.negativePrompt;
      delete originalParams.clipSkip;
    }
  }

  const isSD3 = getIsSD3(originalParams.baseModel);
  if (isSD3) {
    originalParams.sampler = 'undefined';
    originalParams.draft = false;
    if (originalResources.find((x) => x.id === 983611)) {
      originalParams.steps = 4;
      originalParams.cfgScale = 1;
    }
  }

  const status = await getGenerationStatus();
  if (!status.available && !user.isModerator)
    throw throwBadRequestError('Generation is currently disabled');

  const limits = status.limits[user?.tier ?? 'free'];

  const { model, vae, additionalResources, injectable, hasMinorResource, hasPoiResource } =
    await getGenerationResourceData(originalResources, limits.resources, user);

  if (!model) throw throwBadRequestError('A checkpoint is required to make a generation request');
  const isFluxStandard = getIsFluxStandard(model.model.id);
  if (!isFluxStandard) {
    delete originalParams.fluxMode;
    delete originalParams.fluxUltraAspectRatio;
    delete originalParams.fluxUltraRaw;
  }

  let params = { ...originalParams };

  const injectableResources = getInjectablResources(params.baseModel);

  // handle missing draft resource
  if (params.draft && !injectableResources.draft)
    throw throwBadRequestError(`Draft mode is currently disabled for ${params.baseModel} models`);
  // #region [together]

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

  // Disable nsfw if the prompt contains poi/minor words
  const hasPoi = includesPoi(params.prompt) || hasPoiResource;
  if (hasPoi && originalParams.disablePoi) {
    throw throwBadRequestError(
      'Your request contains or attempts to use the likeness of a real person. Generating these type of content while viewing X-XXX ratings is not allowed.'
    );
  }

  const positivePrompts = [params.prompt];
  const negativePrompts = [params.negativePrompt];
  const resourcesToInject: typeof injectable = [];
  if (params.draft && injectableResources.draft) {
    for (const item of [injectableResources.draft]) {
      const resource = injectable.find((x) => x.id === item.id);
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
    if (!injectableResources.draft) params.sampler = 'LCM';
  }

  let upscaleWidth = params.upscaleHeight;
  let upscaleHeight = params.upscaleWidth;
  if (params.sourceImage?.upscaleWidth && params.sourceImage.upscaleHeight) {
    upscaleWidth = params.sourceImage.upscaleWidth;
    upscaleHeight = params.sourceImage.upscaleHeight;
  } else if (!params.upscaleHeight || !params.upscaleWidth) {
    upscaleWidth = params.width * 1.5;
    upscaleHeight = params.height * 1.5;
  }

  const upscale =
    upscaleHeight && upscaleWidth
      ? getRoundedWidthHeight({ width: upscaleWidth, height: upscaleHeight })
      : undefined;

  const { sourceImage, width, height } = params;
  const rest = sourceImage
    ? { image: sourceImage.url, width: sourceImage.width, height: sourceImage.height }
    : { width, height };

  // if (params.baseModel === 'HiDream') {
  //   const hiDreamResult = getHiDreamInput({
  //     model,
  //     resources: additionalResources,
  //     ...params,
  //     ...rest,
  //   });
  //   const { model: hiDreamModel, resources: hiDreamResources, ...restHiDream } = hiDreamResult;

  //   return {
  //     resources: [hiDreamModel, ...hiDreamResources],
  //     params: removeEmpty({
  //       quantity,
  //       batchSize,
  //       ...restHiDream,
  //     }),
  //   };
  // }

  return {
    resources: [model, ...additionalResources, vae, ...resourcesToInject].filter(isDefined),
    params: removeEmpty({
      ...params,
      quantity,
      batchSize,
      prompt: positivePrompts.join(', '),
      negativePrompt: negativePrompts.join(', '),
      ...rest,
      // temp?
      upscaleWidth: upscale?.width,
      upscaleHeight: upscale?.height,
    }),
    // priority: getUserPriority(status, user),
  };
}

function getResources(step: WorkflowStep) {
  const metadata = (step.metadata as Record<string, any>) ?? {};
  const resources: { id: number; strength?: number | null; epochNumber?: number | undefined }[] =
    metadata.resources ?? metadata.params?.resources ?? [];

  return resources;
}

function combineResourcesWithInputResource(
  allResources: GenerationResource[],
  resources: { id: number; strength?: number | null }[]
): GenerationResource[] {
  return allResources
    .map((resource) => {
      const original = resources.find((x) => x.id === resource.id);
      if (!original) return null;
      return { ...resource, strength: original.strength ?? resource.strength };
    })
    .filter(isDefined);
}

export type WorkflowFormatted = AsyncReturnType<typeof formatGenerationResponse>[number];
export async function formatGenerationResponse(workflows: Workflow[], user?: SessionUser) {
  const steps = workflows.flatMap((x) => x.steps ?? []);
  const allResources = steps.flatMap(getResources);
  const versions = allResources.map(({ id, epochNumber }) => ({ id, epoch: epochNumber }));
  const { resources, injectable } = await getResourceDataWithInjects(versions, user);

  return workflows.map((workflow) => {
    const transactions =
      workflow.transactions?.list?.map(({ type, amount, accountType }) => ({
        type,
        amount,
        accountType,
      })) ?? [];

    return {
      id: workflow.id as string,
      status: workflow.status ?? ('unassignend' as WorkflowStatus),
      createdAt: workflow.createdAt ? new Date(workflow.createdAt) : new Date(),
      transactions,
      cost: workflow.cost,
      tags: workflow.tags ?? [],
      duration:
        workflow.startedAt && workflow.completedAt
          ? Math.round(
              new Date(workflow.completedAt).getTime() / 1000 -
                new Date(workflow.startedAt).getTime() / 1000
            )
          : undefined,
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
    case 'imageGen':
      return formatImageGenStep(args);
    case 'videoGen':
    case 'videoEnhancement':
      return formatVideoGenStep(args);
    default:
      throw new Error(
        `failed to extract generation resources: unsupported workflow type ${step.$type}`
      );
  }
}

function formatImageGenStep({
  step,
  resources = [],
  workflowId,
}: {
  step: WorkflowStep;
  resources?: GenerationResource[];
  workflowId: string;
}) {
  const { input, output, jobs } = step as ImageGenStep;
  const metadata = (step.metadata ?? {}) as GeneratedImageStepMetadata;
  const { params, resources: stepResources = [] } = metadata;

  const { width = 1024, height = 1024 } =
    params?.sourceImage ?? (params as { width?: number; height?: number });

  const groupedImages = (jobs ?? []).reduce<Record<string, NormalizedGeneratedImage[]>>(
    (acc, job, i) => ({
      ...acc,
      [job.id]:
        output?.images
          ?.filter((x) => (x.jobId ? x.jobId === job.id : true))
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
            width: image.width ?? width,
            height: image.height ?? height,
            blockedReason: image.blockedReason,
            nsfwLevel: image.nsfwLevel,
          })) ?? [],
    }),
    {}
  );

  const images = Object.values(groupedImages).flat();

  return {
    $type: 'imageGen' as const,
    timeout: step.timeout,
    name: step.name,
    params: params!,
    images,
    status: step.status,
    metadata: metadata as GeneratedImageStepMetadata,
    resources: combineResourcesWithInputResource(resources, stepResources),
  };
}

function formatVideoGenStep({
  step,
  workflowId,
  resources,
}: {
  step: WorkflowStep;
  workflowId: string;
  resources: GenerationResource[];
}) {
  const { input, output, jobs } = step as VideoGenStep;
  const videoMetadata = step.metadata as { params: VideoGenerationSchema2 };
  const params = videoMetadata.params ?? {};

  // handle legacy source image
  let sourceImage = 'sourceImage' in params ? params.sourceImage : undefined;
  if (
    'width' in params &&
    'height' in params &&
    'sourceImage' in params &&
    typeof params.sourceImage === 'string'
  ) {
    sourceImage = {
      width: params.width as number,
      height: params.height as number,
      url: params.sourceImage,
    };
  }

  let width: number | undefined;
  let height: number | undefined;
  let aspectRatio = 1;

  if (sourceImage) {
    width = sourceImage?.width;
    height = sourceImage?.height;
    if (!('aspectRatio' in params)) aspectRatio = width && height ? width / height : 16 / 9;
    else {
      const [rw, rh] = (params.aspectRatio as string).split(':').map(Number);
      aspectRatio = rw / rh;
    }
  } else {
    switch (params.engine) {
      case 'minimax':
        aspectRatio = 16 / 9;
        break;
      case 'mochi':
        width = 848;
        height = 480;
        aspectRatio = width / height;
        break;
      default: {
        if (!params.aspectRatio) params.aspectRatio = '16:9';
        const [rw, rh] = params.aspectRatio.split(':').map(Number);
        aspectRatio = rw / rh;
        break;
      }
    }
  }

  if (typeof aspectRatio === 'string') {
    const [rw, rh] = (aspectRatio as string).split(':').map(Number);
    aspectRatio = rw / rh;
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
            width: output?.video?.width ?? width ?? 1080,
            height: output?.video?.height ?? height ?? 1080,
            queuePosition: job.queuePosition,
            aspectRatio,
            blockedReason: image.blockedReason,
            nsfwLevel: image.nsfwLevel,
          })) ?? [],
    }),
    {}
  );
  const videos = Object.values(grouped).flat();
  const metadata = (step.metadata ?? {}) as GeneratedImageStepMetadata;
  const stepResources = (params && 'resources' in params ? params.resources ?? [] : [])?.map(
    ({ air, strength }) => {
      const { version } = parseAIR(air);
      return { id: version, strength };
    }
  );

  // it's silly, but video resources are nested in the params, where image resources are not
  if (params && 'resources' in params) params.resources = null;

  const combinedResources = combineResourcesWithInputResource(resources, stepResources);

  let baseModel =
    metadata.params?.baseModel ??
    (combinedResources.length
      ? getBaseModelFromResources(
          combinedResources.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
        )
      : undefined);

  // TODO - come up with a better way to handle jsonb data type mismatches
  if ('type' in params && (params.type === 'txt2vid' || params.type === 'img2vid'))
    params.process = params.type;

  if (!params.process && baseModel) {
    const wanProcess = wanBaseModelMap[baseModel as keyof typeof wanBaseModelMap]?.process;
    if (wanProcess) (params as any).process = wanProcess as any;
  }

  if (baseModel === 'WanVideo') {
    if (params.process === 'txt2vid') baseModel = 'WanVideo14B_T2V';
    else baseModel = 'WanVideo14B_I2V_720p';
  }

  return {
    $type: 'videoGen' as const,
    timeout: step.timeout,
    name: step.name,
    // workflow and quantity are only here because they are required for other components to function
    params: removeEmpty({
      ...params!,
      baseModel,
      sourceImage: sourceImage,
      // workflow: videoMetadata.params?.workflow,
      quantity: 1,
    }) as typeof params,
    images: videos,
    status: step.status,
    metadata,
    resources: combineResourcesWithInputResource(resources, stepResources),
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

  const checkpoint = resources.find((x) => x.model.type === 'Checkpoint');
  const baseModel = getBaseModelSetType(checkpoint?.baseModel);
  const injectable = getInjectablResources(baseModel);

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
            width: image.width ?? input.width,
            height: image.height ?? input.height,
            blockedReason: image.blockedReason,
            nsfwLevel: image.nsfwLevel,
          })) ?? [],
    }),
    {}
  );

  const images = Object.values(groupedImages).flat();

  const injectableIds = Object.values(injectable)
    .map((x) => x?.id)
    .filter(isDefined);

  const params = metadata?.params;

  const data = {
    ...params,
    fluxUltraRaw:
      input.engine === 'flux-pro-raw' ? true : input.model === fluxUltraAir ? false : undefined,
  } as TextToImageParams;

  if (resources.some((x) => x.id === fluxUltraAirId)) {
    delete data.steps;
    delete data.cfgScale;
    delete data.clipSkip;
    delete (data as any).draft;
    delete (data as any).nsfw;
  }

  return {
    $type: 'textToImage' as const,
    timeout: step.timeout,
    name: step.name,
    // TODO - after a month from deployment(?), we should be able to start using `step.metadata.params`
    // at that point in time, we can also make params and resources required properties on metadata to ensure that it doesn't get removed by step metadata updates
    params: removeEmpty(data),
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

  // if (params?.aspectRatio) {
  //   const size = getSizeFromAspectRatio(Number(params.aspectRatio), params?.baseModel);
  //   params.width = size.width;
  //   params.height = size.height;
  // }

  const { width = 512, height = 512 } =
    (params?.sourceImage && typeof params.sourceImage !== 'string' ? params.sourceImage : params) ??
    {};

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
            width: width,
            height: height,
            blockedReason: image.blockedReason,
            nsfwLevel: image.nsfwLevel,
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

// const MEMBERSHIP_PRIORITY: Record<UserTier, Priority> = {
//   free: Priority.LOW,
//   founder: Priority.NORMAL,
//   bronze: Priority.NORMAL,
//   silver: Priority.NORMAL,
//   gold: Priority.HIGH,
// };
// export function getUserPriority(status: GenerationStatus, user: { tier?: UserTier }) {
//   if (!status.membershipPriority) return Priority.NORMAL;
//   return MEMBERSHIP_PRIORITY[user.tier ?? 'free'];
// }
