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
import { removeEmpty } from '~/utils/object-helpers';
import {
  samplersToSchedulers,
  samplersToComfySamplers,
} from '~/shared/constants/generation.constants';

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
  const ecosystem = resource.baseModel.toLowerCase();
  const type = resource.model.type.toLowerCase();
  return `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
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
  seed?: number;
  width: number;
  height: number;
  quantity?: number;
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

/**
 * Creates comfy step input from generation graph output.
 * Only returns $type and input - wrapping handled at router level.
 *
 * Handles:
 * - sampler → comfy sampler/scheduler conversion
 * - Resource application (checkpoint, LoRA, etc.)
 */
async function createComfyInput(args: {
  /** Comfy workflow key (e.g., 'img2img-upscale') */
  key: string;
  /** Full generation graph output */
  graphData: GenerationGraphOutput;
  /** Data to populate the comfy workflow template */
  workflowData: Record<string, unknown>;
  /** Resources to apply to the workflow (model, LoRAs, VAE, etc.) */
  resources?: ResourceData[];
}): Promise<StepInput> {
  const { key, graphData, workflowData, resources = [] } = args;
  const quantity = 'quantity' in graphData ? (graphData.quantity as number) : 1;

  // Convert sampler to comfy sampler/scheduler if present in workflowData
  let finalWorkflowData = workflowData;
  if ('sampler' in workflowData && workflowData.sampler) {
    const comfySampler =
      samplersToComfySamplers[
        (workflowData.sampler as keyof typeof samplersToComfySamplers) ?? 'DPM++ 2M Karras'
      ];
    finalWorkflowData = {
      ...workflowData,
      sampler: comfySampler.sampler,
      scheduler: comfySampler.scheduler,
    };
  }

  const comfyWorkflow = await populateWorkflowDefinition(key, finalWorkflowData);

  // Apply resources (checkpoint, LoRAs, VAE, etc.) to the workflow
  if (resources.length > 0) {
    applyResources(
      comfyWorkflow,
      resources.map((resource) => ({
        air: resourceToAir(resource),
        strength: resource.strength,
      }))
    );
  }

  const imageMetadata = JSON.stringify(removeEmpty(finalWorkflowData));

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
  const { video, interpolationFactor } = data;

  if (!video?.url) {
    throw new Error('Video URL is required for video interpolation');
  }

  return {
    $type: 'videoInterpolation',
    input: {
      video: video.url,
      interpolationFactor: interpolationFactor as 2 | 3 | 4,
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
  const { images, scaleFactor } = data;

  if (!images?.length || !images[0]?.url) {
    throw new Error('Image URL is required for image upscaling');
  }

  const sourceImage = images[0];

  return createComfyInput({
    key: 'img2img-upscale',
    graphData: data,
    workflowData: {
      image: sourceImage.url,
      width: sourceImage.width,
      height: sourceImage.height,
      upscale: scaleFactor,
    },
  });
}

/**
 * Handle img2img:remove-background workflow
 */
async function createImageRemoveBackgroundInput(
  data: Extract<GenerationGraphOutput, { workflow: 'img2img:remove-background' }>
): Promise<StepInput> {
  const { images } = data;

  if (!images?.length || !images[0]?.url) {
    throw new Error('Image URL is required for background removal');
  }

  const sourceImage = images[0];

  return createComfyInput({
    key: 'img2img-background-removal',
    graphData: data,
    workflowData: {
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

  if (isDraft) {
    finalResources.push(
      isSD1
        ? { id: SD1_DRAFT_RESOURCE_ID, strength: 1, baseModel: 'SD 1.5', model: { id: 424706, type: 'LORA' } }
        : { id: SDXL_DRAFT_RESOURCE_ID, strength: 1, baseModel: 'SDXL 1.0', model: { id: 391999, type: 'LORA' } }
    );
    steps = isSD1 ? 6 : 8;
    cfgScale = 1;
    sampler = isSD1 ? 'LCM' : 'Euler';
  }

  const scheduler = samplersToSchedulers[sampler as keyof typeof samplersToSchedulers] as Scheduler;

  // Use comfy for img2img, face-fix, and hires-fix workflows
  if (useComfy) {
    const comfyKey = COMFY_WORKFLOW_KEY_MAP[data.workflow] ?? data.workflow;
    const isHires = data.workflow.includes('hires');
    const isImg2Img = data.workflow.startsWith('img2img');

    const workflowData: Record<string, unknown> = {
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      seed: data.seed,
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
    } else {
      workflowData.width = data.aspectRatio.width;
      workflowData.height = data.aspectRatio.height;
      workflowData.denoise = data.denoise;
    }

    if (isHires) {
      workflowData.upscaleWidth = Math.round(data.aspectRatio.width * 1.5);
      workflowData.upscaleHeight = Math.round(data.aspectRatio.height * 1.5);
    }

    return createComfyInput({
      key: comfyKey,
      graphData: data,
      workflowData,
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
    seed: data.seed,
    width: data.aspectRatio.width,
    height: data.aspectRatio.height,
    quantity: data.quantity,
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
 */
export async function createWorkflowStepFromGraph(
  data: GenerationGraphOutput,
  isWhatIf: boolean = false
): Promise<WorkflowStepTemplate> {
  const stepInput = await createStepInput(data);

  // TODO: Derive priority from data.priority when available
  // TODO: Derive timeout based on step type and resources
  // TODO: Build metadata from data when not whatIf

  return {
    ...stepInput,
    // priority, timeout, metadata will be set here
  } as WorkflowStepTemplate;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Submits a generation workflow using generation-graph input
 */
export async function generateFromGraph({ input, externalCtx, token, userId }: GenerateOptions) {
  const data = validateInput(input, externalCtx);
  const step = await createWorkflowStepFromGraph(data, false);

  // TODO: Submit workflow to orchestrator
  // TODO: Add prompt auditing
  // TODO: Add workflow tags
  // TODO: Handle tips, callbacks, etc.

  return { step, data };
}

/**
 * Submits a what-if request using generation-graph input
 */
export async function whatIfFromGraph({ input, externalCtx, userId }: WhatIfOptions) {
  const data = validateInput(input, externalCtx);
  const step = await createWorkflowStepFromGraph(data, true);

  // TODO: Submit what-if request to orchestrator

  return { step, data };
}
