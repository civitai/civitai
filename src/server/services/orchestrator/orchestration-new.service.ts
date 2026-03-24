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
 *    - img2img:upscale → comfy step (img2img-upscale)
 *    - img2img:remove-background → comfy step
 *    - All other workflows → ecosystem discriminator
 *
 * 2. ecosystem DISCRIMINATOR (second level - via ecosystemGraph):
 *    - Routes to appropriate step type based on ecosystem
 */

import type { WorkflowCost, WorkflowStepTemplate } from '@civitai/client';
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
import { resourceSchema, type ResourceData } from '~/shared/data-graph/generation/common';
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
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { toStepMetadata } from '~/shared/utils/resource.utils';
import { maxRandomSeed } from '~/server/common/constants';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

// Ecosystem handlers - unified router
import { createEcosystemStepInput } from './ecosystems';
import { createComfyInput, resourcesToImageMetadataResources } from './ecosystems/comfy-input';
import { removeEmpty } from '~/utils/object-helpers';

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
    [key: string]: unknown;
  };
  sourceMetadataMap?: Record<
    string,
    {
      params?: Record<string, unknown>;
      resources?: Array<Record<string, unknown>>;
      transformations?: Array<{
        workflow: string;
        params?: Record<string, unknown>;
        resources?: Array<Record<string, unknown>>;
      }>;
    }
  >;
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
  isModerator?: boolean;
  token: string;
  currencies?: BuzzSpendType[];
};

/**
 * Step input returned by step creators.
 * Based on WorkflowStepTemplate with required $type and input.
 * Allows optional overrides for priority, timeout, metadata at the creator level.
 *
 * Step creators that need per-step source metadata (e.g., upscale, remove-bg,
 * or chained workflows) should call `buildResolvedSource` and set the
 * `resolvedSource` field so the wrapper uses pre-computed source metadata.
 */
type StepInput = WorkflowStepTemplate & {
  input: unknown;
  /** Pre-computed source metadata from step creators via `buildResolvedSource`. */
  resolvedSource?: { metadata: Record<string, unknown>; imageMetadata: string };
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
  userTier: GenerationCtx['user']['tier'] = 'free',
  flags?: Partial<FeatureAccess>
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
      flags,
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

/** Enriched resource with air string (always populated by getResourceData) */
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

  const enrichedResources: EnrichedResource[] = resources;

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
 *
 * For img2vid:ref2vid, elements count as "has content" — if elements are
 * provided, the workflow is kept even when images is empty.
 */
function normalizeVideoWorkflow(input: Record<string, unknown>): Record<string, unknown> {
  let workflow = input.workflow as string | undefined;
  const images = input.images as unknown[] | undefined;
  const hasImages = Array.isArray(images) && images.length > 0;

  if (workflow === 'img2vid' && !hasImages) {
    workflow = 'txt2vid';
  } else if (workflow === 'img2vid:ref2vid' && !hasImages) {
    // Keep ref2vid if elements are provided (elements substitute for images)
    const elements = input.elements as unknown[] | undefined;
    const hasElements = Array.isArray(elements) && elements.length > 0;
    if (!hasElements) workflow = 'txt2vid';
  }

  return { ...input, workflow };
}

/**
 * Applies all workflow normalizations to input.
 * Handles txt2img ↔ img2img:edit and video workflow corrections.
 */
function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  // Resolve workflow variants to their base workflow before processing.
  // e.g., 'img2vid:first-last' → 'img2vid' so handlers don't need to know about variants.
  const config = workflowConfigByKey.get(input.workflow as string);
  if (config?.variantOf) {
    input = { ...input, workflow: config.variantOf };
  }
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
 * Handle img2img:upscale workflow.
 * Returns an array of step inputs — one per non-excluded image in the batch.
 */
async function createImageUpscaleSteps(
  data: Extract<GenerationGraphOutput, { workflow: 'img2img:upscale' }>,
  sourceCtx?: SourceCtx
): Promise<StepInput[]> {
  const images = data.images ?? [];
  const targetDimensions = data.targetDimensions ?? [];

  // Build steps for non-null entries (images that can be upscaled)
  const steps: Promise<StepInput>[] = [];
  for (let i = 0; i < images.length; i++) {
    const dims = targetDimensions[i];
    if (!dims) continue; // null = excluded

    const image = images[i];
    if (!image?.url) {
      throw new Error(`Invalid image data at index ${i}`);
    }

    steps.push(
      createComfyInput({
        key: 'img2img-upscale',
        params: { image: image.url, upscaleWidth: dims.width, upscaleHeight: dims.height },
      }).then((step) => {
        if (!sourceCtx) return step;
        return { ...step, resolvedSource: buildResolvedSource(image.url, sourceCtx) };
      })
    );
  }

  if (steps.length === 0) {
    throw new Error('No images can be upscaled with the selected settings');
  }

  return Promise.all(steps);
}

/**
 * Handle img2img:remove-background workflow
 */
async function createImageRemoveBackgroundInput(
  data: Extract<GenerationGraphOutput, { workflow: 'img2img:remove-background' }>,
  sourceCtx?: SourceCtx
): Promise<StepInput> {
  const sourceImage = data.images?.[0];
  if (!sourceImage?.url) {
    throw new Error('Image URL is required for background removal');
  }

  const step = await createComfyInput({
    key: 'img2img-background-removal',
    params: {
      image: sourceImage.url,
      width: sourceImage.width,
      height: sourceImage.height,
    },
  });

  if (!sourceCtx) return step;
  return { ...step, resolvedSource: buildResolvedSource(sourceImage.url, sourceCtx) };
}

// =============================================================================
// Main Router
// =============================================================================

/** Context for step-level metadata (imageMetadata, params/resources, source lineage) */
type StepMetadataCtx = {
  stepMetadata: { params?: Record<string, unknown>; resources?: Array<Record<string, unknown>> };
  isWhatIf: boolean;
  sourceCtx?: SourceCtx;
};

/**
 * Creates fully-formed step inputs with imageMetadata and step-level metadata applied.
 * Routes to the appropriate step creator, then applies metadata to all returned steps.
 *
 * Step creators that need per-step source metadata (upscale, remove-bg, or future
 * chained workflows) pre-compute via `buildResolvedSource`. For all other steps,
 * metadata is applied generically using `buildImageMetadata`.
 */
async function createStepInputs(
  data: GenerationGraphOutput,
  handlerCtx: GenerationHandlerCtx,
  metadataCtx: StepMetadataCtx
): Promise<StepInput[]> {
  let rawResult: StepInput | StepInput[];

  // Route to step creator
  switch (data.workflow) {
    case 'vid2vid:interpolate':
      rawResult = createVideoInterpolationInput(data);
      break;

    case 'vid2vid:upscale':
      rawResult = createVideoUpscaleInput(data);
      break;

    case 'img2img:upscale':
      rawResult = await createImageUpscaleSteps(data, metadataCtx.sourceCtx);
      break;

    case 'img2img:remove-background':
      rawResult = await createImageRemoveBackgroundInput(data, metadataCtx.sourceCtx);
      break;

    default: {
      // Ecosystem workflows - ecosystem must be defined
      if (!('ecosystem' in data) || !data.ecosystem) {
        throw new Error('ecosystem is required for ecosystem workflows');
      }
      rawResult = await createEcosystemStepInput(data as EcosystemGraphOutput, handlerCtx);
      break;
    }
  }

  const rawSteps = Array.isArray(rawResult) ? rawResult : [rawResult];
  if (metadataCtx.isWhatIf) return rawSteps;

  // Apply imageMetadata + step-level metadata to each step
  return rawSteps.map((step) => {
    const { resolvedSource, metadata: additionalMetadata, ...rest } = step;

    // Step creator pre-computed source metadata — use it directly
    if (resolvedSource) {
      return {
        ...rest,
        input: { ...(rest.input as object), imageMetadata: resolvedSource.imageMetadata },
        metadata: resolvedSource.metadata,
      };
    }

    // TODO (remove by 2026-04-10): Step-computed params (e.g. upscaleWidth/upscaleHeight) are
    // now computed nodes on the graph and flow into workflow.metadata automatically via
    // toStepMetadata. This merge is kept for backwards compatibility in case any handler
    // still returns additionalMetadata.params. Remove once confirmed no handlers do this.
    const mergedMeta = { ...metadataCtx.stepMetadata };
    if (
      additionalMetadata &&
      'params' in additionalMetadata &&
      typeof additionalMetadata.params === 'object'
    ) {
      mergedMeta.params = { ...mergedMeta.params, ...additionalMetadata.params };
      metadataCtx.stepMetadata.params = mergedMeta.params;
    }

    // Source context fallback (step creators that don't pre-compute)
    if (metadataCtx.sourceCtx) {
      const resolved = buildResolvedSource(undefined, metadataCtx.sourceCtx);
      if (resolved) {
        return {
          ...rest,
          input: { ...(rest.input as object), imageMetadata: resolved.imageMetadata },
          metadata: resolved.metadata,
        };
      }
    }

    // Standard: build imageMetadata from merged step metadata.
    // Don't store full params/resources on step — they live on workflow.metadata.
    // Preserve handler-set metadata fields (e.g. suppressOutput for multi-step workflows).
    const handlerMeta =
      additionalMetadata && typeof additionalMetadata === 'object'
        ? Object.fromEntries(
            Object.entries(additionalMetadata).filter(([k]) => k !== 'params' && k !== 'resources')
          )
        : {};
    return {
      ...rest,
      input: {
        ...(rest.input as object),
        imageMetadata: buildImageMetadata(mergedMeta.params, mergedMeta.resources),
      },
      metadata: handlerMeta,
    };
  });
}

type SourceMetadataInput = {
  params?: Record<string, unknown>;
  resources?: Array<Record<string, unknown>>;
};

/**
 * Context for building per-step source metadata.
 * Passed to step creators so they can store the original generation's
 * params/resources on each step (for "remix from original" after
 * enhancement chains or multi-step workflows).
 */
type SourceCtx = {
  sourceMetadata?: SourceMetadataInput;
  sourceMetadataMap?: Record<string, SourceMetadataInput>;
  workflow: string;
};

/**
 * Build the imageMetadata JSON string from params and resources.
 * This is used by all step types to embed generation metadata in the step input.
 */
function buildImageMetadata(
  params?: Record<string, unknown>,
  resources?: Array<Record<string, unknown>>
): string {
  return JSON.stringify(
    removeEmpty({
      ...params,
      resources: resourcesToImageMetadataResources(resources),
    })
  );
}

/**
 * Builds resolved source metadata for a step.
 * The step stores the original generation's params/resources (what you'd remix to)
 * plus the workflow key (what action this step performed).
 * The step's own params (form input) live on workflow.metadata.
 *
 * @param sourceImageUrl - The source image URL to look up per-image metadata (undefined = use single sourceMetadata)
 * @param ctx - Source context with per-image metadata and workflow key
 * @returns Resolved source (metadata + imageMetadata string), or undefined if no source metadata
 */
function buildResolvedSource(
  sourceImageUrl: string | undefined,
  ctx: SourceCtx
): { metadata: Record<string, unknown>; imageMetadata: string } | undefined {
  // Look up per-image metadata from map, falling back to single sourceMetadata
  const source =
    ctx.sourceMetadataMap && sourceImageUrl
      ? ctx.sourceMetadataMap[sourceImageUrl] ?? ctx.sourceMetadata
      : ctx.sourceMetadata;
  if (!source) return undefined;

  const { params, resources } = source;
  return {
    metadata: {
      params: params ?? {},
      resources: resourcesToImageMetadataResources(resources),
      workflow: ctx.workflow,
    },
    imageMetadata: buildImageMetadata(params, resources),
  };
}

/**
 * Creates workflow steps from validated generation-graph data.
 * Returns steps + workflow-level metadata (the form input snapshot).
 *
 * Performs:
 * - Resource validation (subscription, expired epochs, canGenerate, POI)
 * - POI prompt detection
 * - Private generation detection
 * - Timeout calculation (base 20 min + 1 min per additional resource)
 */
export async function createWorkflowStepsFromGraph({
  data,
  isWhatIf = false,
  user,
  sourceMetadata,
  sourceMetadataMap,
  remixOfId,
}: {
  data: GenerationGraphOutput;
  isWhatIf?: boolean;
  user?: { id?: number; isModerator?: boolean };
  sourceMetadata?: SourceMetadataInput;
  sourceMetadataMap?: Record<string, SourceMetadataInput>;
  remixOfId?: number;
}): Promise<{ steps: WorkflowStepTemplate[]; workflowMetadata?: Record<string, unknown> }> {
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

  // Resolve seed before creating step input and metadata so both use the same value.
  const resolvedData =
    !('seed' in data) || data.seed == null
      ? { ...data, seed: Math.floor(Math.random() * maxRandomSeed) }
      : data;

  // Calculate timeout: base 20 minutes + 1 minute per additional resource
  const timeSpan = new TimeSpan(0, 20, 0);
  timeSpan.addMinutes(Math.max(0, enrichedResources.length - 1));
  const timeout = timeSpan.toString(['hours', 'minutes', 'seconds']);

  // Convert graph output to legacy {resources, params} format for storage
  const stepMetadata = toStepMetadata(
    resolvedData as Record<string, unknown> & {
      model?: { id: number; model: { type: string } };
      resources?: { id: number; model: { type: string } }[];
      vae?: { id: number; model: { type: string } };
    }
  );

  const needsSourceMetadata = workflowConfigByKey.get(data.workflow)?.enhancement === true;

  // Build source context for workflows with source lineage (not needed for what-if)
  const sourceCtx: SourceCtx | undefined =
    !isWhatIf && needsSourceMetadata
      ? { sourceMetadata, sourceMetadataMap, workflow: data.workflow }
      : undefined;

  // Create step inputs with imageMetadata + step-level metadata applied
  const steps = await createStepInputs(resolvedData, handlerCtx, {
    stepMetadata,
    isWhatIf,
    sourceCtx,
  });

  // Wrap with request-level concerns: priority, timeout, outputFormat
  // isPrivateGeneration and remixOfId live on workflow.metadata, not per-step
  // Intermediate steps (videoInterpolation) don't get outputFormat injected
  const wrappedSteps = steps.map((step) => ({
    $type: step.$type,
    input: {
      ...(step.input as object),
      outputFormat: data.outputFormat,
    },
    priority: data.priority,
    timeout,
    metadata: isWhatIf ? undefined : (step.metadata as object),
  })) as WorkflowStepTemplate[];

  // Build workflow-level metadata — the form input snapshot for workflow-level replay
  const workflowMetadata = isWhatIf
    ? undefined
    : removeEmpty({
        params: removeEmpty(stepMetadata.params as Record<string, unknown>),
        resources: stepMetadata.resources,
        remixOfId,
        isPrivateGeneration,
      });

  return { steps: wrappedSteps, workflowMetadata };
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
  isGreen,
  allowMatureContent,
  currencies,
  civitaiTip,
  creatorTip,
  tags: customTags = [],
  sourceMetadata,
  sourceMetadataMap,
  remixOfId,
  track,
}: GenerateOptions) {
  const data = validateInput(input, externalCtx);

  // Audit prompt before generation
  if ('prompt' in data && typeof data.prompt === 'string' && data.prompt.trim()) {
    const negativePrompt = 'negativePrompt' in data ? (data.negativePrompt as string) : undefined;
    await auditPromptServer({
      prompt: data.prompt,
      negativePrompt,
      userId,
      isGreen: !!isGreen,
      isModerator,
      track,
    });
  }

  const { steps, workflowMetadata } = await createWorkflowStepsFromGraph({
    data,
    user: { id: userId, isModerator },
    sourceMetadata,
    sourceMetadataMap,
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

  // Check if private generation (from workflow metadata)
  const isPrivateGeneration = !!(workflowMetadata as { isPrivateGeneration?: boolean })
    ?.isPrivateGeneration;

  // Submit workflow to orchestrator
  const workflow = (await submitWorkflow({
    token,
    body: {
      tags,
      steps,
      tips,
      experimental,
      metadata: workflowMetadata,
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
  isModerator,
  token,
  currencies,
}: WhatIfOptions) {
  // Provide fallback for fields that don't affect cost estimation.
  // The client excludes prompt/negativePrompt from whatIf queries for optimization,
  // so we default them to pass validation when not provided.
  const whatIfInput = { prompt: 'cost-estimation', negativePrompt: '', ...input };
  const data = validateInput(whatIfInput, externalCtx);
  const { steps } = await createWorkflowStepsFromGraph({
    data,
    isWhatIf: true,
    user: userId ? { id: userId, isModerator } : undefined,
  });

  // Submit what-if request to orchestrator
  const workflow = await submitWorkflow({
    token,
    body: {
      steps,
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
  /**
   * Source generation params (for steps with source lineage — e.g., upscale, remove-bg).
   * Undefined for standard generation steps (use workflow.metadata.params instead).
   */
  params?: Partial<GenerationGraphValues> & Record<string, unknown>;
  /**
   * Source generation resources (for steps with source lineage).
   * Undefined for standard generation steps (use workflow.metadata.resources instead).
   */
  resources?: GenerationResource[];
  /** Remix reference (legacy — new writes put this on workflow.metadata) */
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
  /**
   * When true, this step's output should be hidden from the user.
   * Used for intermediate steps in multi-step workflows (e.g., Wan 2.2 videoGen before interpolation).
   */
  suppressOutput?: boolean;
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
  /** Metadata with resolved params/resources */
  metadata: NormalizedStepMetadata;
  /** Output images/videos */
  images: NormalizedWorkflowStepOutput[];
  /** Step errors */
  errors?: string[];
}

/** Workflow-level metadata — the generation form input snapshot. */
export interface NormalizedWorkflowMetadata {
  /** The generation form params (prompt, steps, model settings, etc.) */
  params: Partial<GenerationGraphValues> & Record<string, unknown>;
  /** The generation form resources (model, LoRAs, VAE, etc.) — enriched */
  resources: GenerationResource[];
  /** Remix reference */
  remixOfId?: number;
  /** Whether the generation was private */
  isPrivateGeneration?: boolean;
}

/** Normalized workflow response */
export interface NormalizedWorkflow {
  id: string;
  status: WorkflowStatus;
  createdAt: Date;
  transactions: TransactionInfo[];
  cost: WorkflowCost;
  tags: string[];
  allowMatureContent?: boolean | null;
  duration?: number;
  /** Workflow-level metadata — the form input snapshot for replay. */
  metadata?: NormalizedWorkflowMetadata;
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
    | Array<{ air?: string; id?: number; strength?: number } & Partial<ResourceData>>
    | undefined;
  if (paramsResources && paramsResources.length > 0) {
    return paramsResources.map((r) => {
      // Handle AIR format (video workflows use { air, strength })
      if (r.air && !r.id) {
        const { version } = parseAIR(r.air);
        return { id: version, strength: r.strength };
      }
      return {
        id: r.id!,
        strength: r.strength,
        epochNumber: r.epochDetails?.epochNumber,
      };
    });
  }

  // Fall back to metadata.resources (ResourceData format from data-graph)
  // Enhancement steps store resources via resourcesToImageMetadataResources which uses
  // { modelVersionId } instead of { id }, so check both fields.
  const metadataResources = metadata.resources as
    | Array<ResourceData & { modelVersionId?: number }>
    | undefined;
  const refs = (metadataResources ?? [])
    .map((r) => ({
      id: r.id ?? r.modelVersionId,
      strength: r.strength,
      epochNumber: r.epochDetails?.epochNumber,
    }))
    .filter((r) => r.id != null);

  // Legacy: also collect from source.resources (old format stored original gen in source)
  const source = metadata.source as { resources?: Array<Record<string, unknown>> } | undefined;
  if (source?.resources) {
    const existingIds = new Set(refs.map((r) => r.id));
    for (const r of source.resources) {
      const id = r.id as number | undefined;
      if (id && !existingIds.has(id)) {
        refs.push({ id, strength: r.strength as number | undefined, epochNumber: undefined });
      }
    }
  }

  return refs;
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
            r.id === ref.id && (r.epochDetails?.epochNumber ?? r.epochNumber) === ref.epochNumber
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
    blob?: ImageBlob;
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
    case 'imageUpscaler':
      return output.blob ? [{ ...output.blob, type: 'image' as const }] : [];
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
  step: StepWithOutput,
  resolvedParams?: Record<string, unknown>
): { images: NormalizedWorkflowStepOutput[]; errors: string[] } {
  const items = normalizeStepOutput(step);
  const metadata = (step.metadata as Record<string, unknown>) ?? {};
  const params = resolvedParams ?? ((metadata.params ?? {}) as Record<string, unknown>);
  const seed = params.seed as number | undefined;
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

      // Check upscaleWidth/upscaleHeight: new-format equivalent of transformation
      // targetDimensions. Set by hires-fix workflows to represent the final output
      // size after upscaling, which differs from the source image width/height.
      if (!width || !height) {
        width = params.upscaleWidth as number | undefined;
        height = params.upscaleHeight as number | undefined;
      }

      // Fall back to source dimensions from params (input image dims for img2img,
      // or aspect ratio target dims for txt2img)
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
 *
 * Output shape:
 * - `metadata.params` = resolved params (workflow key already present in raw params)
 * - `metadata.resources` = resolved resources (enriched)
 *
 * Format handling:
 * - Legacy (transformations[]): root params/resources are the original generation
 * - Legacy (source field): source has the original generation, root has the step's action
 * - Current format: root params contain workflow key
 */
function formatStep(
  workflowId: string,
  step: WorkflowStep,
  allResources: GenerationResource[],
  workflowMetadata?: Record<string, unknown>
): NormalizedStep {
  const metadata = (step.metadata ?? {}) as Record<string, unknown>;
  const rawParams = (metadata.params ?? {}) as Record<string, unknown>;
  const hasStepParams = Object.keys(rawParams).length > 0;
  const transformations = metadata.transformations as StepMetadataTransformation[] | undefined;

  // Build enriched resources from step.metadata.resources
  const stepResources = getResourcesFromStep(step, allResources);

  // Resolve step-level params/resources based on format.
  // Legacy formats always populate step params. New format only has step params for enhancements.
  let resolvedParams: Record<string, unknown> | undefined;
  let resolvedResources: GenerationResource[] | undefined;
  let remixOfId: number | undefined;

  if (Array.isArray(transformations) && transformations.length > 0) {
    // Legacy format (transformations[]): root params/resources are the original generation.
    resolvedParams = rawParams;
    resolvedResources = stepResources;
    remixOfId = metadata.remixOfId as number | undefined;
  } else if (metadata.source && typeof metadata.source === 'object') {
    // Legacy format (source field): source has the original generation, root has step's own action.
    const rawSource = metadata.source as Record<string, unknown>;
    const sourceParams = (rawSource.params as Record<string, unknown>) ?? {};
    resolvedParams = sourceParams;
    remixOfId = (rawSource.remixOfId ?? metadata.remixOfId) as number | undefined;

    // Enrich source resources
    const rawSourceResources = rawSource.resources as Array<Record<string, unknown>> | undefined;
    resolvedResources =
      rawSourceResources && rawSourceResources.length > 0
        ? rawSourceResources
            .map((r) => {
              const id = r.id as number | undefined;
              if (!id) return null;
              const enriched = allResources.find((ar) => ar.id === id);
              if (!enriched) return null;
              return { ...enriched, strength: (r.strength as number) ?? enriched.strength };
            })
            .filter((r): r is GenerationResource => r !== null)
        : stepResources;
  } else if (hasStepParams) {
    // Step has its own params (legacy standard gen, or enhancement with params at root).
    resolvedParams = rawParams;
    resolvedResources = stepResources;
    remixOfId = metadata.remixOfId as number | undefined;
  } else {
    // New format: step has no params/resources (standard gen).
    // Data lives on workflow.metadata — don't fabricate step-level data.
    remixOfId = undefined;
  }

  // Map to graph format (workflow, ecosystem, aspectRatio resolution) if we have params
  let finalParams: Record<string, unknown> | undefined;
  if (resolvedParams) {
    const mapped = mapDataToGraphInput(resolvedParams, resolvedResources ?? [], {
      stepType: step.$type,
    });
    finalParams = removeEmpty({ ...resolvedParams, ...mapped });
  }

  // For dimension resolution, use step params or fall back to workflow params
  const paramsForDimensions = finalParams ?? (workflowMetadata?.params as Record<string, unknown>);

  // Format outputs
  const { images, errors } = formatStepOutputs(
    workflowId,
    step as StepWithOutput,
    paramsForDimensions
  );

  return {
    $type: step.$type,
    name: step.name,
    status: step.status,
    timeout: step.timeout,
    completedAt: step.completedAt,
    queuePosition: step.jobs?.[0]?.queuePosition,
    metadata: {
      ...removeEmpty({
        params: finalParams,
        remixOfId,
        images: metadata.images as NormalizedStepMetadata['images'],
        suppressOutput: metadata.suppressOutput as boolean | undefined,
      }),
      ...(resolvedResources?.length ? { resources: resolvedResources } : {}),
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
  // Collect all resource IDs from all steps AND workflow metadata
  // getResourceRefsFromStep handles both regular format and video format (AIR strings)
  const allResourceRefs: Array<{ id: number; epoch?: number }> = [];
  for (const workflow of workflows) {
    // Collect from workflow.metadata.resources
    const wfMeta = (workflow.metadata ?? {}) as Record<string, unknown>;
    const wfResources = wfMeta.resources as ResourceData[] | undefined;
    if (wfResources) {
      for (const r of wfResources) {
        allResourceRefs.push({ id: r.id, epoch: r.epochDetails?.epochNumber });
      }
    }
    // Collect from step resources
    for (const step of workflow.steps ?? []) {
      const refs = getResourceRefsFromStep(step);
      allResourceRefs.push(...refs.map((r) => ({ id: r.id, epoch: r.epochNumber })));
    }
  }

  // Deduplicate by (id, epoch) — not just id — so different epochs of the same version survive
  const uniqueRefs = Array.from(
    new Map(allResourceRefs.map((r) => [`${r.id}_${r.epoch ?? ''}`, r])).values()
  );
  const enrichedResources = uniqueRefs.length > 0 ? await getResourceData(uniqueRefs, user) : [];

  // Format each workflow
  return workflows.map((workflow) => {
    const transactions = workflow.transactions?.list ?? [];
    // Orchestrator defaults metadata to {} — treat empty object as missing
    const rawWfMeta = (workflow.metadata ?? undefined) as Record<string, unknown> | undefined;
    const hasWfMeta = rawWfMeta && 'params' in rawWfMeta;

    // Format steps first — needed for historic metadata fallback
    const steps = (workflow.steps ?? []).map((step) =>
      formatStep(workflow.id as string, step, enrichedResources, hasWfMeta ? rawWfMeta : undefined)
    );

    // Build workflow-level metadata
    let normalizedWfMeta: NormalizedWorkflowMetadata | undefined;
    if (hasWfMeta) {
      const wfParams = (rawWfMeta.params ?? {}) as Record<string, unknown>;
      const wfRawResources = rawWfMeta.resources as ResourceData[] | undefined;
      const wfResources: GenerationResource[] = [];
      for (const r of wfRawResources ?? []) {
        const enriched = enrichedResources.find((ar) => ar.id === r.id);
        if (enriched) {
          wfResources.push({ ...enriched, strength: r.strength ?? enriched.strength });
        }
      }

      // Map params to graph format (workflow, ecosystem, aspectRatio resolution)
      const mapped = mapDataToGraphInput(wfParams, wfResources);
      normalizedWfMeta = {
        params: removeEmpty({ ...wfParams, ...mapped }),
        resources: wfResources,
        ...(rawWfMeta.remixOfId != null ? { remixOfId: rawWfMeta.remixOfId as number } : {}),
        ...(rawWfMeta.isPrivateGeneration
          ? { isPrivateGeneration: rawWfMeta.isPrivateGeneration as boolean }
          : {}),
      };
    } else if (steps.length > 0) {
      // Historic workflow — no workflow-level metadata.
      // Fall back to step metadata for remix support.
      const rawStepMeta = ((workflow.steps ?? [])[0]?.metadata ?? {}) as Record<string, unknown>;
      const transformations = rawStepMeta.transformations as
        | StepMetadataTransformation[]
        | undefined;

      if (Array.isArray(transformations) && transformations.length > 0) {
        // Legacy enhancement: last transformation is the workflow metadata
        const lastTransform = transformations[transformations.length - 1];
        const tParams = (lastTransform.params ?? {}) as Record<string, unknown>;
        const tResources: GenerationResource[] = [];
        for (const r of (lastTransform.resources ?? []) as ResourceData[]) {
          const enriched = enrichedResources.find((ar) => ar.id === r.id);
          if (enriched) {
            tResources.push({ ...enriched, strength: r.strength ?? enriched.strength });
          }
        }
        const mapped = mapDataToGraphInput(tParams, tResources);
        normalizedWfMeta = {
          params: removeEmpty({ ...tParams, ...mapped }),
          resources: tResources,
          ...(rawStepMeta.remixOfId != null ? { remixOfId: rawStepMeta.remixOfId as number } : {}),
        };
      } else {
        // Standard gen: use formatted step metadata
        const first = steps[0].metadata;
        if (first.params || first.resources?.length) {
          normalizedWfMeta = {
            params: first.params ?? {},
            resources: first.resources ?? [],
            ...(first.remixOfId != null ? { remixOfId: first.remixOfId } : {}),
          };
        }
      }
    }

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
      metadata: normalizedWfMeta,
      steps,
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
    const wfMeta = (result.metadata ?? {}) as Record<string, unknown>;
    const wfParams = (wfMeta.params ?? {}) as Record<string, unknown>;

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

        // For dimension resolution, prefer step params (legacy format stores upscale dims there),
        // fall back to workflow-level params (new format stores them on workflow.metadata).
        const stepParams = (metadata.params ?? {}) as Record<string, unknown>;
        const paramsForDimensions = Object.keys(stepParams).length > 0 ? stepParams : wfParams;

        // Format step outputs using the shared utility
        const { images, errors } = formatStepOutputs(
          workflowId,
          step as StepWithOutput,
          paramsForDimensions
        );

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
