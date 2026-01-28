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

import type { WorkflowStepTemplate } from '@civitai/client';
import { TimeSpan } from '@civitai/client';
import {
  generationGraph,
  type GenerationGraphTypes,
} from '~/shared/data-graph/generation/generation-graph';
import {
  getInputTypeForWorkflow,
  workflowConfigByKey,
} from '~/shared/data-graph/generation/config/workflows';
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
import { WORKFLOW_TAGS, samplersToComfySamplers } from '~/shared/constants/generation.constants';
import { includesPoi } from '~/utils/metadata/audit';
import { getEcosystemName } from '~/shared/constants/basemodel.constants';

// Ecosystem handlers - unified router
import { createEcosystemStepInput } from './ecosystems';

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
// External Context Builder
// =============================================================================

/** Result of buildGenerationContext including status for early checks */
export type GenerationContextResult = {
  externalCtx: GenerationCtx;
  status: {
    available: boolean;
    message?: string;
  };
};

/**
 * Builds the GenerationCtx from user tier information.
 * Fetches generation status to get tier-based limits.
 *
 * @param userTier - The user's subscription tier
 * @returns GenerationCtx with limits and user info, plus status for availability checks
 */
export async function buildGenerationContext(
  userTier: GenerationCtx['user']['tier'] = 'free'
): Promise<GenerationContextResult> {
  const status = await getGenerationStatus();
  const limits = status.limits[userTier];

  return {
    externalCtx: {
      limits: {
        maxQuantity: limits.quantity,
        maxResources: limits.resources,
      },
      user: {
        isMember: userTier !== 'free',
        tier: userTier,
      },
    },
    status: {
      available: status.available,
      message: status.message ?? undefined,
    },
  };
}

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
      `Some of your resources are not available for generation: ${unavailable
        .map((r) => r.name)
        .join(', ')}`
    );
  }

  // Build enriched resources with AIR strings
  const enrichedResources: EnrichedResource[] = resources.map((r) => ({
    ...r,
    air: `urn:air:${getEcosystemName(r.baseModel)}:${r.model.type.toLowerCase()}:civitai:${
      r.model.id
    }@${r.id}`,
  }));

  return {
    enrichedResources,
    isPrivateGeneration: hasPrivateOrEpoch,
    hasPoiResource: resources.some((r) => r.model.poi),
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

  const upscaleWidth = sourceImage.width * data.scaleFactor;
  const upscaleHeight = sourceImage.height * data.scaleFactor;

  return createComfyInput({
    key: 'img2img-upscale',
    params: {
      image: sourceImage.url,
      upscaleWidth,
      upscaleHeight,
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

  return createEcosystemStepInput(data as EcosystemGraphOutput);
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
  isWhatIf = false,
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

  const { $type, input } = await createStepInput(data);

  // Calculate timeout: base 20 minutes + 1 minute per additional resource
  const timeSpan = new TimeSpan(0, 20, 0);
  timeSpan.addMinutes(Math.max(0, enrichedResources.length - 1));
  const timeout = timeSpan.toString(['hours', 'minutes', 'seconds']);

  return {
    $type,
    input: { ...(input as object), outputFormat: data.outputFormat },
    priority: data.priority,
    timeout,
    metadata: isWhatIf
      ? undefined
      : {
          isPrivateGeneration,
          input: data,
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
 * - Graph input validation
 * - Resource validation (subscription, epochs, canGenerate, POI)
 * - Prompt POI detection
 *
 * Note: Generation status check should be done in the router before calling this function.
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
  const data = validateInput(input, externalCtx);
  const step = await createWorkflowStepFromGraph(data, false, { id: userId, isModerator });

  // Determine workflow tags
  const baseModel = 'baseModel' in data ? data.baseModel : undefined;
  const [process, name] = data.workflow.split(':');

  const tags = [
    WORKFLOW_TAGS.GENERATION,
    data.output === 'image' ? WORKFLOW_TAGS.IMAGE : WORKFLOW_TAGS.VIDEO,
    process,
    name,
    baseModel,
    ...customTags,
  ].filter(isDefined);

  // Build tips object if provided
  const tips =
    civitaiTip || creatorTip ? { civitai: civitaiTip ?? 0, creators: creatorTip ?? 0 } : undefined;

  // Check if private generation (from step metadata)
  const isPrivateGeneration = !!(step.metadata as { isPrivateGeneration?: boolean })
    ?.isPrivateGeneration;

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

// =============================================================================
// What-If Defaults
// =============================================================================

/** Placeholder image for cost estimation when source image doesn't affect cost */
const WHATIF_PLACEHOLDER_IMAGE = {
  url: 'https://placeholder.test/whatif.png',
  width: 512,
  height: 512,
};

/**
 * Applies placeholder defaults for non-cost-affecting fields in what-if requests.
 * This allows cost estimation before the user fills in all required fields
 * (e.g., before typing a prompt or uploading a source image).
 *
 * Only fills fields that don't affect cost:
 * - prompt: text content doesn't affect pricing
 * - images: specific source image doesn't affect pricing for ecosystem workflows
 *
 * Does NOT fill placeholders for standalone enhancement workflows (upscale,
 * remove-background, vid2vid) where source media dimensions affect cost.
 */
function applyWhatIfDefaults(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  const workflow = result.workflow as string | undefined;
  if (!workflow) return result;

  const inputType = getInputTypeForWorkflow(workflow);

  // Fill prompt for text-input workflows (prompt text doesn't affect cost)
  if (inputType === 'text' && !result.prompt) {
    result.prompt = 'cost estimation';
  }

  // Fill images for ecosystem image-input workflows
  // Standalone enhancements (ecosystemIds: []) need actual dimensions, so skip those
  if (inputType === 'image') {
    const images = result.images as unknown[] | undefined;
    if (!images || images.length === 0) {
      const config = workflowConfigByKey.get(workflow);
      if (config && config.ecosystemIds.length > 0) {
        result.images = [WHATIF_PLACEHOLDER_IMAGE];
      }
    }
  }

  // Video-input workflows (vid2vid:*) are standalone and need actual video metadata
  // for cost calculation (dimensions * scaleFactor, fps * interpolationFactor), so no defaults

  return result;
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
  const data = validateInput(applyWhatIfDefaults(input), externalCtx);
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
