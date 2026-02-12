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
 * 2. ecosystem DISCRIMINATOR (second level - via ecosystemGraph):
 *    - Routes to appropriate step type based on ecosystem
 */

import type { WorkflowStepTemplate } from '@civitai/client';
import { TimeSpan } from '@civitai/client';
import {
  generationGraph,
  type GenerationGraphTypes,
  type GenerationGraphValues,
} from '~/shared/data-graph/generation/generation-graph';
import {
  getInputTypeForWorkflow,
  isWorkflowAvailable,
  workflowConfigByKey,
} from '~/shared/data-graph/generation/config/workflows';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { getResourceData } from '~/server/services/generation/generation.service';
import type { GenerationResource } from '~/shared/types/generation.types';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { generationStatusSchema } from '~/server/schema/generation.schema';
import type { GenerationStatus } from '~/server/schema/generation.schema';
import type { TextToImageResponse } from '~/server/services/orchestrator/types';
import { getWorkflow, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { mapDataToGraphInput } from './legacy-metadata-mapper';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { getOrchestratorCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import { Availability } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { includesPoi } from '~/utils/metadata/audit';
import { ecosystemByKey, getEcosystemName } from '~/shared/constants/basemodel.constants';
import { toStepMetadata } from '~/shared/utils/resource.utils';

// Ecosystem handlers - unified router
import { createEcosystemStepInput } from './ecosystems';
import { createComfyInput } from './ecosystems/comfy-input';

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
  sourceMetadata?: {
    params?: Record<string, unknown>;
    resources?: Array<Record<string, unknown>>;
  };
  remixOfId?: number;
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

/** Ecosystem workflows - GenerationGraphOutput where ecosystem is defined */
type EcosystemGraphOutput = Extract<GenerationGraphOutput, { ecosystem: string }>;

/**
 * A Map that throws an error when getting a value that doesn't exist.
 * Used for AIR lookups where a missing value indicates a data problem.
 */
class StrictAirMap extends Map<number, string> {
  /**
   * Gets the AIR string for a resource ID.
   * @throws Error if the resource ID is not found in the map.
   */
  getOrThrow(resourceId: number): string {
    const air = this.get(resourceId);
    if (!air) {
      throw new Error(
        `AIR not found for resource ID ${resourceId}. ` +
          `This indicates a mismatch between form data and enriched resources.`
      );
    }
    return air;
  }
}

/**
 * Context passed to generation handlers.
 * Provides pre-computed AIR strings from server-side resource enrichment.
 */
export type GenerationHandlerCtx = {
  /**
   * Map of resource version ID to pre-computed AIR string.
   * Use `airs.getOrThrow(id)` to get the AIR and throw if not found.
   */
  airs: StrictAirMap;
};

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

async function getGenerationStatus(): Promise<GenerationStatus> {
  return generationStatusSchema.parse(
    JSON.parse(
      (await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.GENERATION.STATUS)) ??
        '{}'
    )
  ) as GenerationStatus;
}

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

/** Resource reference with optional epoch for getResourceData */
type ResourceRef = { id: number; epoch?: number };

/**
 * Collects all resource references from generation graph output.
 * Returns IDs with epoch info from model, resources, and vae fields where present.
 */
function collectResourceIds(data: GenerationGraphOutput): ResourceRef[] {
  const refs: ResourceRef[] = [];

  if ('model' in data && data.model?.id) {
    refs.push({
      id: data.model.id,
      epoch: 'epochDetails' in data.model ? data.model.epochDetails?.epochNumber : undefined,
    });
  }
  if ('resources' in data && data.resources) {
    refs.push(
      ...data.resources.map((r) => ({
        id: r.id,
        epoch: 'epochDetails' in r ? r.epochDetails?.epochNumber : undefined,
      }))
    );
  }
  if ('vae' in data && data.vae?.id) {
    refs.push({
      id: data.vae.id,
      epoch: 'epochDetails' in data.vae ? data.vae.epochDetails?.epochNumber : undefined,
    });
  }

  return refs;
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
  resourceRefs: ResourceRef[],
  user?: { id?: number; isModerator?: boolean }
): Promise<ResourceValidationResult> {
  if (resourceRefs.length === 0) {
    return {
      enrichedResources: [],
      isPrivateGeneration: false,
      hasPoiResource: false,
    };
  }

  const resources = await getResourceData(resourceRefs, user);

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
 * Normalizes workflow between txt2img and img2img:edit based on image state.
 * - txt2img + images present + edit-capable ecosystem → img2img:edit
 * - img2img:edit + no images → txt2img
 * - img2img / img2img:face-fix / img2img:hires-fix + no images → corresponding txt variant
 *
 * Runs before graph validation so the correct workflow's image requirements apply.
 */
function normalizeImageWorkflow(input: Record<string, unknown>): Record<string, unknown> {
  const workflow = input.workflow as string | undefined;
  const images = input.images as unknown[] | undefined;
  const ecosystem = input.ecosystem as string | undefined;
  const hasImages = Array.isArray(images) && images.length > 0;

  if (workflow === 'txt2img' && hasImages && ecosystem) {
    const eco = ecosystemByKey.get(ecosystem);
    if (eco && isWorkflowAvailable('img2img:edit', eco.id)) {
      return { ...input, workflow: 'img2img:edit' };
    }
  } else if (workflow === 'img2img:edit' && !hasImages) {
    return { ...input, workflow: 'txt2img' };
  } else if (!hasImages && workflow?.startsWith('img2img')) {
    // img2img variants without images → corresponding txt variant
    const txtVariant = workflow.replace('img2img', 'txt2img');
    if (txtVariant !== workflow) {
      return { ...input, workflow: txtVariant };
    }
  }

  return input;
}

/**
 * Normalizes video workflows without images back to txt2vid.
 * Handles the case where a user submits img2vid or img2vid:ref2vid
 * without images (e.g., after removing images from the form).
 */
function normalizeVideoWorkflow(input: Record<string, unknown>): Record<string, unknown> {
  let workflow = input.workflow as string | undefined;
  const images = input.images as unknown[] | undefined;
  const hasImages = Array.isArray(images) && images.length > 0;

  // img2vid workflows without images → txt2vid
  if ((workflow === 'img2vid' || workflow === 'img2vid:ref2vid') && !hasImages) {
    workflow = 'txt2vid';
  }

  return { ...input, workflow };
}

/**
 * Applies all workflow normalizations to input.
 * Handles txt2img ↔ img2img:edit and video workflow corrections.
 */
function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  return normalizeVideoWorkflow(normalizeImageWorkflow(input));
}

/**
 * Validates input using the generation graph and returns the validated output.
 * The output type is discriminated by the workflow property.
 */
function validateInput(input: Record<string, unknown>, externalCtx: GenerationCtx) {
  const result = generationGraph.safeParse(normalizeInput(input), externalCtx);

  if (!result.success) {
    const errorMessages = Object.entries(result.errors)
      .map(([key, error]) => `${key}: ${error.message}`)
      .join(', ');
    throw new Error(`Validation failed: ${errorMessages}`);
  }

  return result.data;
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
 *
 * @param data - Validated generation graph output
 * @param handlerCtx - Context with pre-computed AIR strings for resource lookup
 */
async function createStepInput(
  data: GenerationGraphOutput,
  handlerCtx: GenerationHandlerCtx
): Promise<StepInput> {
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

  // Ecosystem workflows - ecosystem must be defined
  if (!('ecosystem' in data) || !data.ecosystem) {
    throw new Error('ecosystem is required for ecosystem workflows');
  }

  return createEcosystemStepInput(data as EcosystemGraphOutput, handlerCtx);
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
export async function createWorkflowStepFromGraph({
  data,
  isWhatIf = false,
  user,
  sourceMetadata,
  remixOfId,
}: {
  data: GenerationGraphOutput;
  isWhatIf?: boolean;
  user?: { id?: number; isModerator?: boolean };
  sourceMetadata?: {
    params?: Record<string, unknown>;
    resources?: Array<Record<string, unknown>>;
    transformations?: StepMetadataTransformation[];
  };
  remixOfId?: number;
}): Promise<WorkflowStepTemplate> {
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

  // Build AIR map from enriched resources for handlers
  const airs = new StrictAirMap(enrichedResources.map((r) => [r.id, r.air]));
  const handlerCtx: GenerationHandlerCtx = { airs };

  const { $type, input } = await createStepInput(data, handlerCtx);

  // Calculate timeout: base 20 minutes + 1 minute per additional resource
  const timeSpan = new TimeSpan(0, 20, 0);
  timeSpan.addMinutes(Math.max(0, enrichedResources.length - 1));
  const timeout = timeSpan.toString(['hours', 'minutes', 'seconds']);

  // Convert graph output to legacy {resources, params} format for storage
  // This allows the legacy-metadata-mapper to read historical data consistently
  const stepMetadata = toStepMetadata(
    data as Record<string, unknown> & {
      model?: { id: number; model: { type: string } };
      resources?: { id: number; model: { type: string } }[];
      vae?: { id: number; model: { type: string } };
    }
  );

  const metadata: Record<string, unknown> = isWhatIf
    ? {}
    : {
        isPrivateGeneration,
        remixOfId,
        ...stepMetadata,
      };

  // Check if this is an enhancement workflow with source metadata
  const isEnhancement = workflowConfigByKey.get(data.workflow)?.enhancement === true;

  // For enhancement workflows with source metadata, restructure metadata to preserve original generation
  if (!isWhatIf && isEnhancement && sourceMetadata) {
    // Use original params/resources as the root-level metadata
    metadata.params = sourceMetadata.params ?? {};
    metadata.resources = sourceMetadata.resources ?? [];

    // Build the new transformation for this enhancement
    const newTransformation = {
      workflow: data.workflow,
      params: stepMetadata.params,
      resources: stepMetadata.resources,
    };

    // If sourceMetadata already has transformations (chained enhancements), append to the array
    // Otherwise, create a new transformations array with just this enhancement
    const existingTransformations = sourceMetadata.transformations ?? [];
    metadata.transformations = [...existingTransformations, newTransformation];
  }

  return {
    $type,
    input: { ...(input as object), outputFormat: data.outputFormat },
    priority: data.priority,
    timeout,
    metadata: isWhatIf ? undefined : metadata,
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
  sourceMetadata,
  remixOfId,
}: GenerateOptions) {
  const data = validateInput(input, externalCtx);
  const step = await createWorkflowStepFromGraph({
    data,
    user: { id: userId, isModerator },
    sourceMetadata,
    remixOfId,
  });

  // Determine workflow tags
  const ecosystem = 'ecosystem' in data ? data.ecosystem : undefined;
  const outputTag = data.output === 'image' ? WORKFLOW_TAGS.IMAGE : WORKFLOW_TAGS.VIDEO;

  const tags = [
    WORKFLOW_TAGS.GENERATION,
    outputTag,
    data.workflow,
    ecosystem,
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
  const [formatted] = await formatGenerationResponse2([workflow], { id: userId } as any);
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

  result.prompt = 'cost estimation';

  // const inputType = getInputTypeForWorkflow(workflow);

  // // Fill prompt for text-input workflows (prompt text doesn't affect cost)
  // if (inputType === 'text' && !result.prompt) {
  //   result.prompt = 'cost estimation';
  // }

  // // Fill images for ecosystem image-input workflows
  // // Standalone enhancements (ecosystemIds: []) need actual dimensions, so skip those
  // if (inputType === 'image') {
  //   const images = result.images as unknown[] | undefined;
  //   if (!images || images.length === 0) {
  //     const config = workflowConfigByKey.get(workflow);
  //     if (config && config.ecosystemIds.length > 0) {
  //       result.images = [WHATIF_PLACEHOLDER_IMAGE];
  //     }
  //   }
  // }

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
  const data = validateInput(applyWhatIfDefaults(normalizeInput(input)), externalCtx);
  const step = await createWorkflowStepFromGraph({
    data,
    isWhatIf: true,
    user: userId ? { id: userId } : undefined,
  });

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

// =============================================================================
// Simplified Generation Response Formatting
// =============================================================================

import type {
  ImageBlob,
  NsfwLevel,
  TransactionInfo,
  VideoBlob,
  Workflow,
  WorkflowStatus,
  WorkflowStep,
  WorkflowStepJobQueuePosition,
} from '@civitai/client';
import type { SessionUser } from 'next-auth';
import type * as z from 'zod';
import type { workflowQuerySchema } from '~/server/schema/orchestrator/workflows.schema';
import { queryWorkflows } from './workflows';
import { parseAIR } from '~/shared/utils/air';

// =============================================================================
// Types
// =============================================================================

/** Normalized output (image or video) from a workflow step */
export interface NormalizedWorkflowStepOutput {
  url: string;
  workflowId: string;
  stepName: string;
  seed?: number | null;
  status: WorkflowStatus;
  aspect: number;
  type: 'image' | 'video';
  id: string;
  available: boolean;
  urlExpiresAt?: string | null;
  jobId?: string | null;
  nsfwLevel?: NsfwLevel;
  blockedReason?: string | null;
  previewUrl?: string | null;
  previewUrlExpiresAt?: string | null;
  width: number;
  height: number;
}

/** Step metadata with mapped params and enriched resources */
export interface NormalizedStepMetadata {
  /** Mapped params ready for the generation graph (workflow, ecosystem, aspectRatio resolved) */
  params: Partial<GenerationGraphValues> & Record<string, unknown>;
  /** Enriched resources with full model/version data for display */
  resources: GenerationResource[];
  /** Remix reference */
  remixOfId?: number;
  /** Per-image metadata (favorite, feedback, hidden, etc.) */
  images?: Record<
    string,
    {
      hidden?: boolean;
      feedback?: 'liked' | 'disliked';
      favorite?: boolean;
      comments?: string;
      postId?: number;
    }
  >;
  /** Transformations applied */
  transformations?: StepMetadataTransformation[];
}

export type StepMetadataTransformation = {
  workflow: string;
  params?: Record<string, unknown>;
  resources?: Record<string, unknown>[];
};

/** Normalized workflow step */
export interface NormalizedStep {
  $type: string;
  name: string;
  status?: WorkflowStatus;
  timeout?: string | null;
  completedAt?: string | null;
  queuePosition?: WorkflowStepJobQueuePosition;
  /** Original params (for backward compatibility) */
  params: Partial<GenerationGraphValues> & Record<string, unknown>;
  /** Enriched resources with full model/version data for display */
  resources: GenerationResource[];
  /** Metadata with mapped params */
  metadata: NormalizedStepMetadata;
  /** Output images/videos */
  images: NormalizedWorkflowStepOutput[];
  /** Step errors */
  errors?: string[];
}

/** Normalized workflow response */
export interface NormalizedWorkflow {
  id: string;
  status: WorkflowStatus;
  createdAt: Date;
  transactions: TransactionInfo[];
  cost?: { type?: string; currency?: string; total?: number; base?: number };
  tags: string[];
  allowMatureContent?: boolean | null;
  duration?: number;
  steps: NormalizedStep[];
}

// =============================================================================
// Resource Helpers
// =============================================================================

/**
 * Extracts resource refs from step metadata (IDs + step-level overrides).
 * Checks metadata.params.resources first (video format with AIR strings),
 * then falls back to metadata.resources (standard format with IDs).
 */
function getResourceRefsFromStep(
  step: WorkflowStep
): Array<{ id: number; strength?: number | null; epochNumber?: number }> {
  const metadata = (step.metadata ?? {}) as Record<string, unknown>;
  const params = (metadata.params ?? {}) as Record<string, unknown>;

  // Try params.resources first (video workflows store resources here)
  const paramsResources = params.resources as
    | Array<{ air?: string; id?: number; strength?: number; epochNumber?: number }>
    | undefined;
  if (paramsResources && paramsResources.length > 0) {
    return paramsResources.map((r) => {
      // Handle AIR format (video workflows use { air, strength })
      if (r.air && !r.id) {
        const { version } = parseAIR(r.air);
        return { id: version, strength: r.strength };
      }
      // Handle ID format (standard format)
      return { id: r.id!, strength: r.strength, epochNumber: r.epochNumber };
    });
  }

  // Fall back to metadata.resources (standard format)
  const metadataResources = metadata.resources as
    | Array<{ id: number; strength?: number | null; epochNumber?: number }>
    | undefined;
  return metadataResources ?? [];
}

/**
 * Returns enriched resources for display in the queue.
 * Preserves full GenerationResource data (model.name, model.id, version name, etc.)
 * and applies per-step strength overrides and epoch details.
 */
function getResourcesFromStep(
  step: WorkflowStep,
  allResources: GenerationResource[]
): GenerationResource[] {
  const refs = getResourceRefsFromStep(step);
  return refs
    .map((ref) => {
      // Match by both id and epochNumber to handle the same model version used with different epochs
      const enriched =
        allResources.find(
          (r) =>
            r.id === ref.id &&
            (r.epochDetails?.epochNumber ?? r.epochNumber) === ref.epochNumber
        ) ?? allResources.find((r) => r.id === ref.id);
      if (!enriched) return null;
      return {
        ...enriched,
        strength: ref.strength ?? enriched.strength,
        epochDetails: enriched.epochDetails
          ? enriched.epochDetails
          : ref.epochNumber
          ? { jobId: '', fileName: '', epochNumber: ref.epochNumber, isExpired: false }
          : undefined,
      };
    })
    .filter(isDefined);
}

// =============================================================================
// Output Formatting
// =============================================================================

type StepWithOutput = WorkflowStep & {
  input?: { seed?: number };
  output?: {
    images?: ImageBlob[];
    video?: VideoBlob;
    blobs?: ImageBlob[];
    errors?: string[];
    externalTOSViolation?: boolean;
    message?: string;
  };
};

/**
 * Normalizes step output (images/videos) to a common format
 */
function normalizeStepOutput(step: StepWithOutput): Array<ImageBlob | VideoBlob> {
  const output = step.output;
  if (!output) return [];

  switch (step.$type) {
    case 'comfy':
      return output.blobs?.map((blob) => ({ ...blob, type: 'image' as const })) ?? [];
    case 'imageGen':
    case 'textToImage':
      return output.images?.map((img) => ({ ...img, type: 'image' as const })) ?? [];
    case 'videoGen':
    case 'videoUpscaler':
    case 'videoEnhancement':
    case 'videoInterpolation':
      return output.video ? [{ ...output.video, type: 'video' as const }] : [];
    default:
      return [];
  }
}

/**
 * Formats step outputs into normalized images array
 */
export function formatStepOutputs(
  workflowId: string,
  step: StepWithOutput
): { images: NormalizedWorkflowStepOutput[]; errors: string[] } {
  const items = normalizeStepOutput(step);
  const seed = 'seed' in (step.input ?? {}) ? (step.input as { seed?: number }).seed : undefined;
  const metadata = (step.metadata as Record<string, unknown>) ?? {};
  const params = (metadata.params ?? {}) as Record<string, unknown>;
  const transformations = (metadata.transformations ?? []) as Array<{
    params?: Record<string, unknown>;
  }>;

  const images: NormalizedWorkflowStepOutput[] = items.map((item, index) => {
    const job = step.jobs?.find((j) => j.id === item.jobId);
    let { width, height } = item;

    // Try to get dimensions from various sources
    if (!width || !height) {
      // Check transformations from last to first to find dimensions
      if (transformations.length > 0) {
        for (let i = transformations.length - 1; i >= 0; i--) {
          const transformation = transformations[i];
          if (!transformation.params) continue;

          // Check for direct width/height first
          const directWidth = transformation.params.width as number | undefined;
          const directHeight = transformation.params.height as number | undefined;

          if (directWidth && directHeight) {
            width = directWidth;
            height = directHeight;
            break;
          }

          // If not found, check for targetDimensions
          const targetDimensions = transformation.params.targetDimensions as
            | { width?: number; height?: number }
            | undefined;
          if (targetDimensions?.width && targetDimensions?.height) {
            width = targetDimensions.width;
            height = targetDimensions.height;
            break;
          }
        }
      }

      // Fall back to main params if not found in transformations
      if (!width || !height) {
        width = params.width as number | undefined;
        height = params.height as number | undefined;
      }

      if (!width || !height) {
        const aspectRatio = params.aspectRatio;
        if (aspectRatio) {
          // Handle both object format { value, width, height } and legacy string format "w:h"
          if (typeof aspectRatio === 'object' && aspectRatio !== null) {
            const ar = aspectRatio as { value?: string; width?: number; height?: number };
            width = ar.width;
            height = ar.height;
          } else if (typeof aspectRatio === 'string') {
            const [w, h] = aspectRatio.split(':').map(Number);
            width = w;
            height = h;
          }
        }

        if (!width || !height) {
          const sourceImage = (params.sourceImage ?? (params.images as unknown[])?.[0]) as
            | { width?: number; height?: number }
            | undefined;
          if (sourceImage) {
            width = sourceImage.width;
            height = sourceImage.height;
          }
        }
      }
    }

    if (!width || !height) {
      width = 512;
      height = 512;
    }

    const aspect = width / height;

    return {
      ...(item as ImageBlob | VideoBlob),
      url: item.url && item.type === 'video' ? `${item.url}.mp4` : (item.url as string),
      workflowId,
      stepName: step.name,
      seed: seed ? seed + index : undefined,
      status: item.available ? 'succeeded' : ((job?.status ?? 'unassigned') as WorkflowStatus),
      aspect,
      width,
      height,
    };
  });

  // Collect errors
  const errors: string[] = [];
  const output = step.output;
  if (output) {
    if ('errors' in output && output.errors) errors.push(...output.errors);
    if (
      'externalTOSViolation' in output &&
      'message' in output &&
      typeof output.message === 'string'
    ) {
      errors.push(output.message);
    }
  }

  return { images, errors };
}

// =============================================================================
// Main Formatting Functions
// =============================================================================

/**
 * Simplified step formatting that works for all step types.
 * Uses mapDataToGraphInput to handle workflow/ecosystem/aspectRatio resolution uniformly.
 */
function formatStep(
  workflowId: string,
  step: WorkflowStep,
  allResources: GenerationResource[]
): NormalizedStep {
  const metadata = (step.metadata ?? {}) as Record<string, unknown>;
  const rawParams = (metadata.params ?? {}) as Record<string, unknown>;

  // Get enriched resources for display (full model/version data)
  const resources = getResourcesFromStep(step, allResources);

  // Map params to graph format (resolves workflow, ecosystem, aspectRatio, etc.)
  // mapDataToGraphInput needs the full GenerationResource[] for model lookup
  const stepGenerationResources = getResourceRefsFromStep(step)
    .map((ref) => {
      const enriched = allResources.find((r) => r.id === ref.id);
      if (!enriched) return null;
      return { ...enriched, strength: ref.strength ?? enriched.strength };
    })
    .filter((r): r is GenerationResource => r !== null);

  const mappedParams = mapDataToGraphInput(rawParams, stepGenerationResources, {
    stepType: step.$type,
  });

  // Format outputs
  const { images, errors } = formatStepOutputs(workflowId, step as StepWithOutput);

  return {
    $type: step.$type,
    name: step.name,
    status: step.status,
    timeout: step.timeout,
    completedAt: step.completedAt,
    queuePosition: step.jobs?.[0]?.queuePosition,
    params: { ...rawParams, ...mappedParams },
    resources,
    metadata: {
      params: { ...rawParams, ...mappedParams },
      resources,
      remixOfId: metadata.remixOfId as number | undefined,
      images: metadata.images as NormalizedStepMetadata['images'],
      transformations: metadata.transformations as StepMetadataTransformation[] | undefined,
    },
    images,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Simplified formatGenerationResponse.
 * Replaces the complex switch-based formatting in common.ts.
 */
export async function formatGenerationResponse2(
  workflows: Workflow[],
  user?: SessionUser
): Promise<NormalizedWorkflow[]> {
  // Collect all resource IDs from all steps
  // getResourceRefsFromStep handles both regular format and video format (AIR strings)
  const allResourceRefs: Array<{ id: number; epoch?: number }> = [];
  for (const workflow of workflows) {
    for (const step of workflow.steps ?? []) {
      const refs = getResourceRefsFromStep(step);
      allResourceRefs.push(...refs.map((r) => ({ id: r.id, epoch: r.epochNumber })));
    }
  }

  // Deduplicate and fetch all resources
  const uniqueRefs = Array.from(new Map(allResourceRefs.map((r) => [r.id, r])).values());
  const enrichedResources = uniqueRefs.length > 0 ? await getResourceData(uniqueRefs, user) : [];

  // Format each workflow
  return workflows.map((workflow) => {
    const transactions = workflow.transactions?.list ?? [];

    return {
      id: workflow.id as string,
      status: workflow.status ?? ('unassigned' as WorkflowStatus),
      createdAt: workflow.createdAt ? new Date(workflow.createdAt) : new Date(),
      transactions,
      cost: workflow.cost,
      tags: workflow.tags ?? [],
      allowMatureContent: workflow.allowMatureContent,
      duration:
        workflow.startedAt && workflow.completedAt
          ? Math.round(
              new Date(workflow.completedAt).getTime() / 1000 -
                new Date(workflow.startedAt).getTime() / 1000
            )
          : undefined,
      steps: (workflow.steps ?? []).map((step) =>
        formatStep(workflow.id as string, step, enrichedResources)
      ),
    };
  });
}

// =============================================================================
// Query Functions
// =============================================================================

export type GeneratedImageWorkflowModel = NormalizedWorkflow;

/**
 * Simplified queryGeneratedImageWorkflows.
 * Replaces the version in common.ts.
 */
export async function queryGeneratedImageWorkflows2({
  user,
  ...props
}: z.output<typeof workflowQuerySchema> & {
  token: string;
  user?: SessionUser;
  hideMatureContent: boolean;
}) {
  const { nextCursor, items } = await queryWorkflows(props);

  return {
    items: await formatGenerationResponse2(items as Workflow[], user),
    nextCursor,
  };
}

// =============================================================================
// Workflow Status Update
// =============================================================================

export type WorkflowStatusUpdate = Awaited<ReturnType<typeof getWorkflowStatusUpdate>>;
export async function getWorkflowStatusUpdate({
  token,
  workflowId,
}: {
  token: string;
  workflowId: string;
}) {
  const result = await getWorkflow({ token, path: { workflowId } });
  if (result) {
    return {
      id: workflowId,
      status: result.status!,
      steps: result.steps?.map((step) => {
        const metadata = (step.metadata ?? {}) as Record<string, unknown>;

        // Get params from either new format (input) or legacy format (params)
        let params: Record<string, unknown>;
        if (
          metadata.input &&
          typeof metadata.input === 'object' &&
          'workflow' in (metadata.input as object)
        ) {
          // New format: metadata.input already contains graph-compatible data
          params = metadata.input as Record<string, unknown>;
        } else {
          // Legacy format: map params using legacy-metadata-mapper
          const legacyParams = (metadata.params ?? {}) as Record<string, unknown>;
          params = mapDataToGraphInput(legacyParams, [], { stepType: step.$type });
        }

        // Format step outputs using the shared utility
        const { images, errors } = formatStepOutputs(workflowId, step as StepWithOutput);

        return {
          name: step.name,
          status: step.status,
          completedAt: step.completedAt,
          params,
          images,
          errors: errors.length > 0 ? errors : undefined,
        };
      }),
    };
  }
}
