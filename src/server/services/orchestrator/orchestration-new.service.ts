/**
 * Orchestration New Service
 *
 * Unified service for submitting generation workflows and what-if requests
 * using the generation-graph v2 data structure.
 *
 * This service uses the generation-graph discriminators to route requests
 * to the appropriate orchestrator step type:
 *
 * 1. WORKFLOW DISCRIMINATOR (first level):
 *    - vid2vid:interpolate → videoInterpolation step
 *    - vid2vid:upscale → videoUpscaler step
 *    - img2img:upscale → comfy step
 *    - img2img:remove-background → comfy step
 *    - All other workflows → ecosystem discriminator
 *
 * 2. BASEMODEL DISCRIMINATOR (second level - via ecosystemGraph):
 *    - Routes to appropriate step type based on ecosystem
 */

import type { ImageJobNetworkParams, Scheduler, WorkflowStepTemplate } from '@civitai/client';
import { TimeSpan } from '@civitai/client';
import {
  generationGraph,
  type GenerationGraphTypes,
} from '~/shared/data-graph/generation/generation-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import {
  applyResources,
  populateWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import {
  getResourceData,
  type GenerationResource,
} from '~/server/services/generation/generation.service';
import {
  formatGenerationResponse,
  getGenerationStatus,
} from '~/server/services/orchestrator/common';
import type { TextToImageResponse } from '~/server/services/orchestrator/types';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { getOrchestratorCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import { Availability } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';
import {
  WORKFLOW_TAGS,
  samplersToSchedulers,
  samplersToComfySamplers,
} from '~/shared/constants/generation.constants';
import { includesPoi } from '~/utils/metadata/audit';
import { maxRandomSeed } from '~/server/common/constants';
import { getRandomInt } from '~/utils/number-helpers';
import { getEcosystemName } from '~/shared/constants/basemodel.constants';

// =============================================================================
// Types
// =============================================================================

/** Validated output from the generation graph */
export type GenerationGraphOutput = GenerationGraphTypes['Ctx'];

/** Context provided by the router */
export type GenerationContext = {
  token: string;
  userId: number;
  experimental?: boolean;
  allowMatureContent?: boolean;
  isGreen?: boolean;
  currencies?: BuzzSpendType[];
  isModerator?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  track?: any; // Tracker class from createContext
  civitaiTip?: number;
  creatorTip?: number;
  tags?: string[];
};

/** Options for submitting a generation */
export type GenerateOptions = {
  input: Record<string, unknown>;
  externalCtx: GenerationCtx;
} & GenerationContext;

/** Options for what-if requests */
export type WhatIfOptions = {
  input: Record<string, unknown>;
  externalCtx: GenerationCtx;
  userId?: number;
  token: string;
  currencies?: BuzzSpendType[];
};

/**
 * Step input returned by step creators.
 * Based on WorkflowStepTemplate with required $type and input.
 * Allows optional overrides for priority, timeout, metadata at the creator level.
 */
type StepInput = WorkflowStepTemplate & {
  input: unknown;
};

/** Ecosystem workflows - GenerationGraphOutput where baseModel is defined */
type EcosystemGraphOutput = Extract<GenerationGraphOutput, { baseModel: string }>;

// =============================================================================
// Ecosystem Family Context Types
// =============================================================================

/** SD family ecosystems context */
type SDFamilyCtx = EcosystemGraphOutput & {
  baseModel: 'SD1' | 'SD2' | 'SDXL' | 'Pony' | 'Illustrious' | 'NoobAI';
};

/** Flux family ecosystems context */
type FluxFamilyCtx = EcosystemGraphOutput & {
  baseModel: 'Flux1' | 'FluxKrea';
};

/** Wan family ecosystems context */
type WanFamilyCtx = EcosystemGraphOutput & {
  baseModel:
    | 'WanVideo'
    | 'WanVideo1_3B_T2V'
    | 'WanVideo14B_T2V'
    | 'WanVideo14B_I2V_480p'
    | 'WanVideo14B_I2V_720p'
    | 'WanVideo22_TI2V_5B'
    | 'WanVideo22_I2V_A14B'
    | 'WanVideo22_T2V_A14B'
    | 'WanVideo25_T2V'
    | 'WanVideo25_I2V';
};

// =============================================================================
// Draft Resource Constants
// =============================================================================

/** SD1 Draft LoRA resource version ID */
const SD1_DRAFT_RESOURCE_ID = 424706;

/** SDXL Draft LoRA resource version ID (also used for Pony, Illustrious, NoobAI) */
const SDXL_DRAFT_RESOURCE_ID = 391999;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Converts a ResourceData object to an AIR string.
 * AIR format: urn:air:{ecosystem}:{type}:{source}:{modelId}@{versionId}
 */
function resourceToAir(resource: ResourceData): string {
  const ecosystem = getEcosystemName(resource.baseModel);
  const type = resource.model.type.toLowerCase();
  return `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
}

/**
 * Collects all resource version IDs from generation graph output.
 * Returns IDs from model, resources, and vae fields where present.
 */
function collectResourceIds(data: GenerationGraphOutput): number[] {
  const ids: number[] = [];

  if ('model' in data && data.model?.id) {
    ids.push(data.model.id);
  }
  if ('resources' in data && data.resources) {
    ids.push(...data.resources.map((r) => r.id));
  }
  if ('vae' in data && data.vae?.id) {
    ids.push(data.vae.id);
  }

  return ids;
}

/** Enriched resource with air string */
type EnrichedResource = GenerationResource & { air: string };

/** Result of resource validation */
type ResourceValidationResult = {
  enrichedResources: EnrichedResource[];
  isPrivateGeneration: boolean;
  hasPoiResource: boolean;
};

/**
 * Validates and enriches resources from generation graph output.
 *
 * Performs:
 * - Subscription validation for private/epoch resources
 * - Expired epoch check
 * - canGenerate validation
 * - POI resource detection
 * - Private generation detection
 */
async function validateAndEnrichResources(
  resourceIds: number[],
  user?: { id?: number; isModerator?: boolean }
): Promise<ResourceValidationResult> {
  if (resourceIds.length === 0) {
    return {
      enrichedResources: [],
      isPrivateGeneration: false,
      hasPoiResource: false,
    };
  }

  const resources = await getResourceData(resourceIds, user);

  // Check for private/epoch resources requiring subscription
  const hasPrivateOrEpoch = resources.some(
    (r) => r.availability === Availability.Private || !!r.epochDetails
  );

  if (hasPrivateOrEpoch && user?.id && !user?.isModerator) {
    const subscription = await getHighestTierSubscription(user.id);
    if (!subscription) {
      throw throwBadRequestError('Using Private resources require an active subscription.');
    }
  }

  // Check for expired epochs
  const expiredEpoch = resources.find((r) => r.epochDetails?.isExpired);
  if (expiredEpoch) {
    throw throwBadRequestError(
      'One of the epochs you are trying to generate with has expired. Make it a private model to continue using it.'
    );
  }

  // Check canGenerate
  const unavailable = resources.filter((r) => !r.canGenerate);
  if (unavailable.length > 0) {
    throw throwBadRequestError(
      `Some of your resources are not available for generation: ${unavailable.map((r) => r.name).join(', ')}`
    );
  }

  // Build enriched resources with AIR strings
  const enrichedResources: EnrichedResource[] = resources.map((r) => ({
    ...r,
    air: `urn:air:${getEcosystemName(r.baseModel)}:${r.model.type.toLowerCase()}:civitai:${r.model.id}@${r.id}`,
  }));

  return {
    enrichedResources,
    isPrivateGeneration: hasPrivateOrEpoch,
    hasPoiResource: resources.some((r) => r.model.poi),
  };
}

/**
 * Creates a textToImage step input.
 * Converts ResourceData to AIRs for the orchestrator.
 */
function createTextToImageInput(args: {
  model: ResourceData;
  resources?: ResourceData[];
  vae?: ResourceData;
  prompt: string;
  negativePrompt?: string;
  scheduler: Scheduler;
  steps: number;
  cfgScale: number;
  clipSkip?: number;
  seed: number;
  width: number;
  height: number;
  quantity: number;
  batchSize: number;
  outputFormat?: string;
}): StepInput {
  const { model, resources = [], vae, ...rest } = args;

  // Build additionalNetworks from resources + vae
  const allResources = [...resources, ...(vae ? [vae] : [])];
  const additionalNetworks = allResources.reduce<Record<string, ImageJobNetworkParams>>(
    (acc, r) => ({
      ...acc,
      [resourceToAir(r)]: {
        strength: r.strength,
        type: r.model.type,
      },
    }),
    {}
  );

  return {
    $type: 'textToImage',
    input: {
      model: resourceToAir(model),
      additionalNetworks,
      ...rest,
    },
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validates input using the generation graph and returns the validated output.
 * The output type is discriminated by the workflow property.
 */
function validateInput(input: Record<string, unknown>, externalCtx: GenerationCtx) {
  const result = generationGraph.safeParse(input, externalCtx);

  if (!result.success) {
    const errorMessages = Object.entries(result.errors)
      .map(([key, error]) => `${key}: ${error.message}`)
      .join(', ');
    throw new Error(`Validation failed: ${errorMessages}`);
  }

  return result.data;
}

// =============================================================================
// Step Input Creators
// =============================================================================

/** Data required for comfy workflow step creation */
type ComfyInputData = {
  /** Comfy workflow key (e.g., 'img2img-upscale') */
  key: string;
  /** Number of images to generate */
  quantity?: number;
  /** Resources to apply (model, LoRAs, VAE) */
  resources?: ResourceData[];
  /** Workflow-specific parameters (prompt, seed, dimensions, etc.) */
  params: Record<string, unknown>;
};

/**
 * Creates comfy step input.
 *
 * Handles:
 * - sampler → comfy sampler/scheduler conversion
 * - Resource application (checkpoint, LoRA, etc.)
 */
async function createComfyInput(data: ComfyInputData): Promise<StepInput> {
  const { key, quantity = 1, resources = [], params } = data;

  // Convert sampler to comfy sampler/scheduler if present
  let workflowData: Record<string, unknown> = { ...params };
  if ('sampler' in params && params.sampler) {
    const comfySampler =
      samplersToComfySamplers[
        (params.sampler as keyof typeof samplersToComfySamplers) ?? 'DPM++ 2M Karras'
      ];
    workflowData = {
      ...workflowData,
      sampler: comfySampler.sampler,
      scheduler: comfySampler.scheduler,
    };
  }

  const comfyWorkflow = await populateWorkflowDefinition(key, workflowData);

  // Apply resources (checkpoint, LoRAs, VAE, etc.) to the workflow
  if (resources.length > 0) {
    const resourcesToApply = resources.map((resource) => ({
      air: resourceToAir(resource),
      strength: resource.strength,
    }));
    workflowData = { ...workflowData, resources: resourcesToApply };
    applyResources(comfyWorkflow, resourcesToApply);
  }

  const imageMetadata = JSON.stringify(removeEmpty(workflowData));

  return {
    $type: 'comfy',
    input: {
      quantity,
      comfyWorkflow,
      imageMetadata,
      useSpineComfy: null,
    },
  };
}

// =============================================================================
// Workflow Discriminator Handlers (Level 1)
// =============================================================================

/**
 * Handle vid2vid:interpolate workflow
 */
function createVideoInterpolationInput(
  data: Extract<GenerationGraphOutput, { workflow: 'vid2vid:interpolate' }>
): StepInput {
  if (!data.video?.url) {
    throw new Error('Video URL is required for video interpolation');
  }

  return {
    $type: 'videoInterpolation',
    input: {
      video: data.video.url,
      interpolationFactor: data.interpolationFactor as 2 | 3 | 4,
    },
  };
}

/**
 * Handle vid2vid:upscale workflow
 */
function createVideoUpscaleInput(
  data: Extract<GenerationGraphOutput, { workflow: 'vid2vid:upscale' }>
): StepInput {
  const { video, scaleFactor } = data;

  if (!video?.url) {
    throw new Error('Video URL is required for video upscaling');
  }

  return {
    $type: 'videoUpscaler',
    input: {
      video: video.url,
      scaleFactor: scaleFactor,
    },
  };
}

/**
 * Handle img2img:upscale workflow
 */
async function createImageUpscaleInput(
  data: Extract<GenerationGraphOutput, { workflow: 'img2img:upscale' }>
): Promise<StepInput> {
  const sourceImage = data.images?.[0];
  if (!sourceImage?.url) {
    throw new Error('Image URL is required for image upscaling');
  }

  return createComfyInput({
    key: 'img2img-upscale',
    params: {
      image: sourceImage.url,
      width: sourceImage.width,
      height: sourceImage.height,
      upscale: data.scaleFactor,
      outputFormat: data.outputFormat,
    },
  });
}

/**
 * Handle img2img:remove-background workflow
 */
async function createImageRemoveBackgroundInput(
  data: Extract<GenerationGraphOutput, { workflow: 'img2img:remove-background' }>
): Promise<StepInput> {
  const sourceImage = data.images?.[0];
  if (!sourceImage?.url) {
    throw new Error('Image URL is required for background removal');
  }

  return createComfyInput({
    key: 'img2img-background-removal',
    params: {
      image: sourceImage.url,
      width: sourceImage.width,
      height: sourceImage.height,
    },
  });
}

// =============================================================================
// Ecosystem Discriminator Handler (Level 2)
// =============================================================================

/** Workflows that use comfy instead of textToImage for SD family */
const SD_COMFY_WORKFLOWS = [
  'img2img',
  'txt2img:face-fix',
  'txt2img:hires-fix',
  'img2img:face-fix',
  'img2img:hires-fix',
] as const;

/** Map generation-graph workflow keys to comfy workflow keys */
const COMFY_WORKFLOW_KEY_MAP: Record<string, string> = {
  'img2img': 'img2img',
  'txt2img:face-fix': 'txt2img-facefix',
  'txt2img:hires-fix': 'txt2img-hires',
  'img2img:face-fix': 'img2img-facefix',
  'img2img:hires-fix': 'img2img-hires',
};

/**
 * Handle SD family workflows (SD1, SD2, SDXL, Pony, Illustrious, NoobAI).
 *
 * Type-safe handler for SD family ecosystems. The input type is narrowed
 * by the switch statement in createEcosystemWorkflowInput.
 */
async function createSDFamilyInput(data: SDFamilyCtx): Promise<StepInput> {
  if (!data.model) throw new Error('Model is required for SD family workflows');
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for SD family workflows');

  const isDraft = data.workflow === 'txt2img:draft';
  const isSD1 = data.baseModel === 'SD1';
  const useComfy = SD_COMFY_WORKFLOWS.includes(
    data.workflow as (typeof SD_COMFY_WORKFLOWS)[number]
  );

  // Mutable copy of resources for adding draft LoRA
  const finalResources = [...(data.resources ?? [])];

  // Add draft LoRA and override settings for draft workflow
  let sampler = data.sampler ?? 'Euler';
  let steps = data.steps ?? 25;
  let cfgScale = data.cfgScale ?? 7;

  // Quantity and batch size for draft optimization
  const requestedQuantity = data.quantity ?? 1;
  let quantity = requestedQuantity;
  let batchSize = 1;

  if (isDraft) {
    finalResources.push(
      isSD1
        ? { id: SD1_DRAFT_RESOURCE_ID, strength: 1, baseModel: 'SD 1.5', model: { id: 424706, type: 'LORA' } }
        : { id: SDXL_DRAFT_RESOURCE_ID, strength: 1, baseModel: 'SDXL 1.0', model: { id: 391999, type: 'LORA' } }
    );
    steps = isSD1 ? 6 : 8;
    cfgScale = 1;
    sampler = isSD1 ? 'LCM' : 'Euler';
    // Draft mode batch optimization: generate 4 images per batch
    quantity = Math.ceil(requestedQuantity / 4);
    batchSize = 4;
  }

  // Auto-generate seed if not provided
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  const scheduler = samplersToSchedulers[sampler as keyof typeof samplersToSchedulers] as Scheduler;

  // Use comfy for img2img, face-fix, and hires-fix workflows
  if (useComfy) {
    const comfyKey = COMFY_WORKFLOW_KEY_MAP[data.workflow] ?? data.workflow;
    const isHires = data.workflow.includes('hires');
    const isImg2Img = data.workflow.startsWith('img2img');

    const workflowData: Record<string, unknown> = {
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      seed,
      steps,
      cfgScale,
      sampler,
      outputFormat: data.outputFormat ?? 'jpeg',
    };

    if (isImg2Img) {
      const sourceImage = data.images?.[0];
      if (!sourceImage?.url) {
        throw new Error('Source image is required for img2img workflows');
      }
      workflowData.image = sourceImage.url;
      workflowData.denoise = data.denoise;
      workflowData.width = sourceImage.width;
      workflowData.height = sourceImage.height;
    } else {
      workflowData.width = data.aspectRatio.width;
      workflowData.height = data.aspectRatio.height;
      workflowData.denoise = data.denoise;
    }

    if (isHires) {
      workflowData.upscaleWidth = Math.round((workflowData.width as number) * 1.5);
      workflowData.upscaleHeight = Math.round((workflowData.height as number) * 1.5);
    }

    return createComfyInput({
      key: comfyKey,
      quantity,
      params: workflowData,
      resources: [data.model, ...finalResources, ...(data.vae ? [data.vae] : [])],
    });
  }

  return createTextToImageInput({
    model: data.model,
    resources: finalResources,
    vae: data.vae,
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    scheduler,
    steps,
    cfgScale,
    clipSkip: data.clipSkip,
    seed,
    width: data.aspectRatio.width,
    height: data.aspectRatio.height,
    quantity,
    batchSize,
    outputFormat: data.outputFormat,
  });
}

/**
 * Handle ecosystem-dependent workflows.
 * Routes to the appropriate step creator based on the baseModel discriminator.
 *
 * Ecosystem groups match ecosystem-graph.ts groupedDiscriminator structure.
 */
async function createEcosystemWorkflowInput(data: EcosystemGraphOutput): Promise<StepInput> {
  switch (data.baseModel) {
    // =========================================================================
    // Image Ecosystems - SD Family
    // =========================================================================
    case 'SD1':
    case 'SD2':
    case 'SDXL':
    case 'Pony':
    case 'Illustrious':
    case 'NoobAI':
      return createSDFamilyInput(data);

    // =========================================================================
    // Image Ecosystems - Flux Family
    // =========================================================================
    case 'Flux1':
    case 'FluxKrea':
      // TODO: return createFluxFamilyInput(data);
      throw new Error(`Flux family not yet implemented: ${data.baseModel}`);

    // =========================================================================
    // Video Ecosystems - Wan Family
    // =========================================================================
    case 'WanVideo':
    case 'WanVideo1_3B_T2V':
    case 'WanVideo14B_T2V':
    case 'WanVideo14B_I2V_480p':
    case 'WanVideo14B_I2V_720p':
    case 'WanVideo22_TI2V_5B':
    case 'WanVideo22_I2V_A14B':
    case 'WanVideo22_T2V_A14B':
    case 'WanVideo25_T2V':
    case 'WanVideo25_I2V':
      // TODO: return createWanFamilyInput(data);
      throw new Error(`Wan family not yet implemented: ${data.baseModel}`);

    // =========================================================================
    // Image Ecosystems - Individual
    // =========================================================================
    case 'Qwen':
    case 'NanoBanana':
    case 'Seedream':
    case 'Imagen4':
    case 'Flux2':
    case 'Flux1Kontext':
    case 'ZImageTurbo':
    case 'Chroma':
    case 'HiDream':
    case 'PonyV7':
    case 'OpenAI':
      throw new Error(`${data.baseModel} not yet implemented`);

    // =========================================================================
    // Video Ecosystems - Individual (API-based, videoGen step)
    // =========================================================================
    case 'Vidu':
    case 'Kling':
    case 'HyV1':
    case 'MiniMax':
    case 'Haiper':
    case 'Mochi':
    case 'Lightricks':
    case 'Sora2':
    case 'Veo3':
      throw new Error(`${data.baseModel} not yet implemented`);

    default:
      throw new Error(`Unknown ecosystem: ${(data as {baseModel: string}).baseModel}`);
  }
}

// =============================================================================
// Main Router
// =============================================================================

/**
 * Routes to the appropriate step input creator based on the workflow discriminator.
 * Returns only $type and input - wrapping with priority/timeout/metadata happens here.
 */
async function createStepInput(data: GenerationGraphOutput): Promise<StepInput> {
  // Standalone workflows (no ecosystem support)
  switch (data.workflow) {
    case 'vid2vid:interpolate':
      return createVideoInterpolationInput(data);

    case 'vid2vid:upscale':
      return createVideoUpscaleInput(data);

    case 'img2img:upscale':
      return createImageUpscaleInput(data);

    case 'img2img:remove-background':
      return createImageRemoveBackgroundInput(data);
  }

  // Ecosystem workflows - baseModel must be defined
  if (!('baseModel' in data) || !data.baseModel) {
    throw new Error('baseModel is required for ecosystem workflows');
  }

  return createEcosystemWorkflowInput(data as EcosystemGraphOutput);
}

/**
 * Creates a complete workflow step from validated generation-graph data.
 * Wraps step input with priority, timeout, and metadata.
 *
 * Performs:
 * - Resource validation (subscription, expired epochs, canGenerate, POI)
 * - POI prompt detection
 * - Private generation detection
 * - Timeout calculation (base 20 min + 1 min per additional resource)
 */
export async function createWorkflowStepFromGraph(
  data: GenerationGraphOutput,
  isWhatIf: boolean = false,
  user?: { id?: number; isModerator?: boolean }
): Promise<WorkflowStepTemplate> {
  // Validate and enrich resources
  const resourceIds = collectResourceIds(data);
  const { enrichedResources, isPrivateGeneration, hasPoiResource } =
    await validateAndEnrichResources(resourceIds, user);

  // Check for POI in prompt
  const prompt = 'prompt' in data ? (data.prompt as string) : undefined;
  const hasPoi = (prompt && includesPoi(prompt)) || hasPoiResource;
  if (hasPoi && 'disablePoi' in data && data.disablePoi) {
    throw throwBadRequestError(
      'Your request contains or attempts to use the likeness of a real person. Generating these type of content while viewing X-XXX ratings is not allowed.'
    );
  }

  const stepInput = await createStepInput(data);

  // Calculate timeout: base 20 minutes + 1 minute per additional resource
  const timeSpan = new TimeSpan(0, 20, 0);
  timeSpan.addMinutes(Math.max(0, enrichedResources.length - 1));
  const timeout = timeSpan.toString(['hours', 'minutes', 'seconds']);

  return {
    ...stepInput,
    priority: data.priority,
    timeout,
    metadata: isWhatIf
      ? undefined
      : {
          isPrivateGeneration,
          ...data
        },
  } as WorkflowStepTemplate;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Submits a generation workflow using generation-graph input.
 *
 * Validates:
 * - Generation status (blocks if disabled and user not moderator)
 * - Graph input validation
 * - Resource validation (subscription, epochs, canGenerate, POI)
 * - Prompt POI detection
 */
export async function generateFromGraph({
  input,
  externalCtx,
  token,
  userId,
  isModerator,
  experimental,
  allowMatureContent,
  currencies,
  civitaiTip,
  creatorTip,
  tags: customTags = [],
}: GenerateOptions) {
  // Check generation status
  const status = await getGenerationStatus();
  if (!status.available && !isModerator) {
    throw throwBadRequestError('Generation is currently disabled');
  }

  const data = validateInput(input, externalCtx);
  const step = await createWorkflowStepFromGraph(data, false, { id: userId, isModerator });

  // Determine workflow tags
  const baseModel = 'baseModel' in data ? data.baseModel : undefined;
  const [process] = data.workflow.split(':')[0]

  const tags = [
    WORKFLOW_TAGS.GENERATION,
    data.output,
    process,
    data.workflow,
    baseModel,
    ...customTags,
  ].filter(isDefined);

  // Build tips object if provided
  const tips = civitaiTip || creatorTip
    ? { civitai: civitaiTip ?? 0, creators: creatorTip ?? 0 }
    : undefined;

  // Check if private generation (from step metadata)
  const isPrivateGeneration = !!(step.metadata as { isPrivateGeneration?: boolean })?.isPrivateGeneration;

  // Submit workflow to orchestrator
  const workflow = (await submitWorkflow({
    token,
    body: {
      tags,
      steps: [step],
      tips,
      experimental,
      callbacks: getOrchestratorCallbacks(userId),
      // Private generation restrictions
      nsfwLevel: isPrivateGeneration ? 'pg13' : undefined,
      allowMatureContent: isPrivateGeneration ? false : allowMatureContent,
      // @ts-ignore - BuzzSpendType is properly supported
      currencies: currencies ? BuzzTypes.toOrchestratorType(currencies) : undefined,
    },
  })) as TextToImageResponse;

  // Format and return response
  const [formatted] = await formatGenerationResponse([workflow], { id: userId } as any);
  return formatted;
}

/**
 * Submits a what-if request using generation-graph input.
 * Returns cost estimation without actually running the generation.
 *
 * Note: What-if requests skip generation status check as they are cost estimates only.
 */
export async function whatIfFromGraph({
  input,
  externalCtx,
  userId,
  token,
  currencies,
}: WhatIfOptions) {
  const data = validateInput(input, externalCtx);
  const step = await createWorkflowStepFromGraph(data, true, userId ? { id: userId } : undefined);

  // Submit what-if request to orchestrator
  const workflow = await submitWorkflow({
    token,
    body: {
      steps: [step],
      // @ts-ignore - BuzzSpendType is properly supported
      currencies: currencies ? BuzzTypes.toOrchestratorType(currencies) : undefined,
    },
    query: {
      whatif: true,
    },
  });

  // Check if all jobs are ready (have available support)
  let ready = true;
  for (const workflowStep of workflow.steps ?? []) {
    for (const job of workflowStep.jobs ?? []) {
      const { queuePosition } = job;
      if (!queuePosition) continue;

      const { support } = queuePosition;
      if (support !== 'available' && ready) ready = false;
    }
  }

  return {
    allowMatureContent: workflow.allowMatureContent,
    transactions: workflow.transactions?.list,
    cost: workflow.cost,
    ready,
  };
}
