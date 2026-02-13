/**
 * Legacy Metadata Mapper
 *
 * Converts historic orchestration metadata (pre-generation-graph) to the new
 * generation-graph input format.
 *
 * Historic format:
 *   step.metadata.resources: { id, strength, epochNumber?, air? }[]
 *   step.metadata.params: TextToImageParams (prompt, negativePrompt, cfgScale, etc.)
 *
 * New format:
 *   step.metadata.input: GenerationGraphOutput
 *     - model: ResourceData (checkpoint)
 *     - resources: ResourceData[] (LoRAs, etc.)
 *     - vae: ResourceData (optional)
 *     - workflow, baseModel, prompt, seed, steps, cfgScale, sampler, etc.
 *
 * See docs/features/legacy-metadata-mapping.md for mapping details and known gaps.
 */

import type { WorkflowStep } from '@civitai/client';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { GeneratedImageStepMetadata } from '~/server/schema/orchestrator/textToImage.schema';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { getBaseModelFromResources } from '~/shared/constants/generation.constants';
import { splitResourcesByType } from '~/shared/utils/resource.utils';
import { parseAIRSafe } from '~/shared/utils/air';
import type { GenerationGraphCtx } from '~/shared/data-graph/generation';
import {
  isWorkflowAvailable,
  isEnhancementWorkflow,
  getOutputTypeForWorkflow,
} from '~/shared/data-graph/generation/config/workflows';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { removeEmpty } from '~/utils/object-helpers';

// =============================================================================
// Workflow Mapping
// =============================================================================

/**
 * Maps old comfy workflow keys to generation-graph workflow keys.
 * Old comfy keys use hyphens, graph keys use colons as variant separators.
 */
const COMFY_KEY_TO_WORKFLOW: Record<string, string> = {
  txt2img: 'txt2img',
  img2img: 'img2img',
  'txt2img-facefix': 'txt2img:face-fix',
  'txt2img-hires': 'txt2img:hires-fix',
  'img2img-facefix': 'img2img:face-fix',
  'img2img-hires': 'img2img:hires-fix',
  'img2img-upscale': 'img2img:upscale',
  'img2img-background-removal': 'img2img:remove-background',
};

/**
 * Reverse of COMFY_KEY_TO_WORKFLOW: maps graph workflow keys back to legacy comfy keys.
 * Used by mapGraphToLegacyParams to restore the hyphenated format the legacy form expects.
 * Special cases (e.g. txt2img:draft → draft flag) are handled separately.
 */
const WORKFLOW_TO_COMFY_KEY: Record<string, string> = {
  'txt2img:face-fix': 'txt2img-facefix',
  'txt2img:hires-fix': 'txt2img-hires',
  'img2img:face-fix': 'img2img-facefix',
  'img2img:hires-fix': 'img2img-hires',
  'img2img:upscale': 'img2img-upscale',
  'img2img:remove-background': 'img2img-background-removal',
  'img2img:edit': 'img2img',
};

/**
 * Flux Ultra aspect ratio dimensions.
 * Used to resolve fluxUltraAspectRatio string → { value, width, height }.
 */
const FLUX_ULTRA_ASPECT_RATIOS: Record<string, { width: number; height: number }> = {
  '21:9': { width: 3136, height: 1344 },
  '16:9': { width: 2752, height: 1536 },
  '4:3': { width: 2368, height: 1792 },
  '1:1': { width: 2048, height: 2048 },
  '3:4': { width: 1792, height: 2368 },
  '9:16': { width: 1536, height: 2752 },
  '9:21': { width: 1344, height: 3136 },
};

/**
 * Maps new fluxMode string values to legacy AIR strings.
 * The legacy form uses AIR strings for fluxMode, while the new graph uses simple mode names.
 */
const FLUX_MODE_TO_AIR: Record<string, string> = {
  draft: 'urn:air:flux1:checkpoint:civitai:618692@699279',
  standard: 'urn:air:flux1:checkpoint:civitai:618692@691639',
  pro: 'urn:air:flux1:checkpoint:civitai:618692@922358',
  krea: 'urn:air:flux1:checkpoint:civitai:618692@2068000',
  ultra: 'urn:air:flux1:checkpoint:civitai:618692@1088507',
};

/**
 * Maps Flux Ultra aspect ratio values to legacy index format.
 * The legacy form uses an index string ("0", "1", etc.) while the new graph uses ratio strings.
 */
const FLUX_ULTRA_ASPECT_RATIO_TO_INDEX: Record<string, string> = {
  '21:9': '0',
  '16:9': '1',
  '4:3': '2',
  '1:1': '3',
  '3:4': '4',
  '9:16': '5',
  '9:21': '6',
};

/**
 * Builds a ResourceData for the model from a fluxMode AIR string.
 * Used when no checkpoint was found in the enriched resources.
 */
function modelFromFluxModeAir(air: string): ResourceData | undefined {
  const parsed = parseAIRSafe(air);
  if (!parsed) return undefined;
  // Legacy mapper - include extra fields for downstream processing
  return {
    id: parsed.version,
  } as ResourceData;
}

// Re-export shared engine utilities for backwards compatibility
export { getEngineFromEcosystem } from '~/shared/utils/engine.utils';
import { ENGINE_TO_ECOSYSTEM, getEngineFromEcosystem } from '~/shared/utils/engine.utils';

// Alias for backwards compatibility with existing code
const ENGINE_TO_BASE_MODEL = ENGINE_TO_ECOSYSTEM;

/**
 * Checks if a baseModel key's ecosystem is listed in a workflow config's ecosystemIds.
 * Uses the aggregated workflowConfigByKey (includes alias ecosystemIds).
 */
function ecosystemSupportsWorkflow(baseModel: string, workflowKey: string): boolean {
  const eco = ecosystemByKey.get(baseModel);
  if (!eco) return false;
  return isWorkflowAvailable(workflowKey, eco.id);
}

/**
 * Refines an img2img process into the correct workflow variant.
 *
 * - With baseModel → `img2img` (images trigger edit mode in handlers)
 * - No inferable baseModel → `img2img:upscale` (likely standalone upscale)
 */
function resolveImg2ImgWorkflow(baseModel: string | undefined): string {
  if (!baseModel) return 'img2img:upscale';
  return 'img2img';
}

/**
 * Refines an img2vid process into the correct workflow variant.
 * Derives supported ecosystems from workflowConfigs rather than hardcoded sets.
 *
 * - Ecosystem in `img2vid:ref2vid` config + 3+ images → `img2vid:ref2vid`
 * - Other → `img2vid`
 */
function resolveImg2VidWorkflow(baseModel: string | undefined, imageCount: number): string {
  if (baseModel) {
    if (imageCount >= 3 && ecosystemSupportsWorkflow(baseModel, 'img2vid:ref2vid')) {
      return 'img2vid:ref2vid';
    }
  }
  return 'img2vid';
}

// =============================================================================
// Ecosystem Compatibility
// =============================================================================

/**
 * Ensures a resolved workflow is compatible with the given ecosystem.
 * When the workflow's category (image/video) doesn't match what the ecosystem
 * supports, crosses over to the equivalent workflow in the other category.
 *
 * e.g. img2img + Kling → img2vid, txt2img + Kling → txt2vid
 */
function ensureEcosystemCompatible(
  workflow: string,
  baseModel: string | undefined,
  imageCount: number
): string {
  if (!baseModel || ecosystemSupportsWorkflow(baseModel, workflow)) return workflow;
  if (isEnhancementWorkflow(workflow)) return workflow;

  const category = getOutputTypeForWorkflow(workflow);
  const hasImages = imageCount > 0;

  // Cross to the other category
  const fallbacks =
    category === 'image'
      ? hasImages
        ? ['img2vid', 'txt2vid']
        : ['txt2vid']
      : hasImages
      ? ['img2img', 'txt2img']
      : ['txt2img'];

  for (const fallback of fallbacks) {
    if (ecosystemSupportsWorkflow(baseModel, fallback)) {
      if (fallback === 'img2vid') return resolveImg2VidWorkflow(baseModel, imageCount);
      return fallback;
    }
  }

  return workflow;
}

// =============================================================================
// Workflow Resolution
// =============================================================================

/**
 * Determines the workflow key from legacy params, step type, and ecosystem context.
 * Resolves from params first, then validates against the ecosystem via
 * ensureEcosystemCompatible.
 *
 * Priority:
 * 1. Comfy workflow key from params.workflow (if $type is 'comfy')
 * 2. Draft detection from params.draft
 * 3. params.workflow if already in new format (contains variant separator)
 * 4. params.process refined by ecosystem context
 * 5. Source image detection → img2img
 * 6. Engine detection → video workflow
 * 7. Fallback → txt2img
 *
 * After resolution, ensureEcosystemCompatible corrects any mismatch
 * (e.g. img2img + Kling ecosystem → img2vid).
 */
export function resolveWorkflow(
  stepType: string | undefined,
  params: GeneratedImageStepMetadata['params'],
  baseModel: string | undefined,
  imageCount: number
): string {
  const resolved = resolveWorkflowFromParams(stepType, params, baseModel, imageCount);
  return ensureEcosystemCompatible(resolved, baseModel, imageCount);
}

/**
 * Raw workflow resolution from params — no ecosystem validation.
 */
function resolveWorkflowFromParams(
  stepType: string | undefined,
  params: GeneratedImageStepMetadata['params'],
  baseModel: string | undefined,
  imageCount: number
): string {
  if (!params) return 'txt2img';

  // 1. For comfy steps, try to map the workflow key directly
  if (stepType === 'comfy' && params.workflow) {
    const mapped = COMFY_KEY_TO_WORKFLOW[params.workflow];
    if (mapped) return mapped;
  }

  // 2. Draft mode
  if (params.draft && (!params.process || params.process === 'txt2img')) {
    return 'txt2img:draft';
  }

  // 3. If workflow already uses new format (image:*/video:*), migrate to old format
  // TODO - remove this after 1 month
  if (params.workflow?.startsWith('image:') || params.workflow?.startsWith('video:')) {
    const NEW_TO_OLD: Record<string, string> = {
      'image:create': 'txt2img',
      'image:edit': 'img2img:edit',
      'image:draft': 'txt2img:draft',
      'image:face-fix': 'txt2img:face-fix',
      'image:hires-fix': 'txt2img:hires-fix',
      'image:upscale': 'img2img:upscale',
      'image:remove-background': 'img2img:remove-background',
      'video:create': 'txt2vid',
      'video:animate': 'txt2vid',
      'video:first-last-frame': 'img2vid',
      'video:ref2vid': 'img2vid:ref2vid',
      'video:upscale': 'vid2vid:upscale',
      'video:interpolate': 'vid2vid:interpolate',
    };
    return NEW_TO_OLD[params.workflow] ?? 'txt2img';
  }

  // 4. Determine base process and refine
  const process = params.process ?? params.workflow;
  if (process) {
    switch (process) {
      case 'img2img':
        return resolveImg2ImgWorkflow(baseModel);
      case 'img2vid':
      case 'img2vid:first-last-frame': // Legacy key, now just img2vid
        return resolveImg2VidWorkflow(baseModel, imageCount);
      case 'ref2vid':
        return 'img2vid:ref2vid';
      case 'txt2img':
        return 'txt2img';
      case 'txt2vid':
        return 'txt2vid';
      default:
        return process;
    }
  }

  // 5. Infer from source images
  if (params.sourceImage || params.images) {
    return resolveImg2ImgWorkflow(baseModel);
  }

  // 6. Detect video workflow from engine parameter
  if (params.engine && ENGINE_TO_BASE_MODEL[params.engine]) {
    if (imageCount > 0) {
      return resolveImg2VidWorkflow(baseModel, imageCount);
    }
    return 'txt2vid';
  }

  // 7. Fallback
  return 'txt2img';
}

// =============================================================================
// BaseModel Inference
// =============================================================================

/**
 * Infers the ecosystem key when params.baseModel/ecosystem is missing.
 *
 * Priority:
 * 1. params.ecosystem or params.baseModel (legacy) - already present
 * 2. params.engine → ENGINE_TO_BASE_MODEL lookup
 * 3. Enriched resources → getBaseModelFromResources (checkpoint baseModel → group)
 */
export function inferBaseModel(
  params: GeneratedImageStepMetadata['params'],
  enrichedResources: GenerationResource[]
): string | undefined {
  // 1. Direct from params (check both new 'ecosystem' and legacy 'baseModel')
  if ((params as any)?.ecosystem) return (params as any).ecosystem;
  if (params?.baseModel) return params.baseModel;

  // 2. From engine (video workflows)
  if (params?.engine) {
    const fromEngine = ENGINE_TO_BASE_MODEL[params.engine];
    if (fromEngine) return fromEngine;
  }

  // 3. From enriched resources (infer from checkpoint/resource baseModel)
  if (enrichedResources.length > 0) {
    return getBaseModelFromResources(
      enrichedResources.map((r) => ({ modelType: r.model.type, baseModel: r.baseModel }))
    );
  }

  return undefined;
}

// Re-export splitResourcesByType for backward compatibility
export { splitResourcesByType } from '~/shared/utils/resource.utils';

/**
 * Converts a GenerationResource to the ResourceData shape used by generation-graph.
 * Merges strength from the legacy resource entry if available.
 * Preserves epochDetails if present on the enriched resource.
 */
function toResourceData(
  enriched: GenerationResource,
  legacyStrength?: number | null
): ResourceData {
  const epochNumber = enriched.epochDetails?.epochNumber ?? enriched.epochNumber;
  // Return minimal ResourceData - extra fields from enriched are used via enrichedResources
  return {
    id: enriched.id,
    baseModel: enriched.baseModel,
    model: { type: enriched.model.type },
    strength: legacyStrength ?? enriched.strength ?? undefined,
    epochDetails: epochNumber != null ? { epochNumber } : undefined,
  };
}

/**
 * Splits resources and converts to ResourceData with legacy strength merging.
 * Used only by mapLegacyMetadata for orchestration step metadata.
 */
function splitResourcesForLegacy(
  enrichedResources: GenerationResource[],
  legacyResources: { id: number; strength?: number | null }[]
) {
  const split = splitResourcesByType(enrichedResources);
  const findLegacy = (id: number) => legacyResources.find((lr) => lr.id === id);

  return {
    model: split.model
      ? toResourceData(split.model, findLegacy(split.model.id)?.strength)
      : undefined,
    resources: split.resources.map((r) => toResourceData(r, findLegacy(r.id)?.strength)),
    vae: split.vae ? toResourceData(split.vae, findLegacy(split.vae.id)?.strength) : undefined,
  };
}

// =============================================================================
// Transformation Mapping
// =============================================================================

/**
 * Maps legacy transformation objects that use 'type' to the new format using 'workflow'.
 * Handles backward compatibility for existing metadata.
 */
function mapTransformations(
  transformations?: Array<Record<string, unknown>>
): Array<Record<string, unknown>> | undefined {
  if (!transformations || !Array.isArray(transformations)) return undefined;

  return transformations.map((t) => {
    // If already has 'workflow', pass through
    if ('workflow' in t && t.workflow) return t;

    // Map legacy 'type' to 'workflow'
    if ('type' in t && t.type) {
      const { type, ...params } = t;
      return { workflow: type, params };
    }

    return t;
  });
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Maps raw generation params + enriched resources into graph-compatible input.
 *
 * Passes through all params by default, only transforming fields that need it:
 * - Computes `workflow` (from stepType + params + ecosystem)
 * - Computes `ecosystem` (from params + resources) - maps legacy 'baseModel' to 'ecosystem'
 * - Computes `aspectRatio` (from width/height into { value, width, height })
 * - Computes `images` (from sourceImage/images array)
 * - Maps legacy names (`openAITransparentBackground` → `transparent`, `openAIQuality` → `quality`)
 * - Strips consumed/internal fields (width, height, sourceImage, process, engine, fluxMode, etc.)
 *
 * Engine-specific params (duration, enablePromptEnhancer, style, resolution, etc.)
 * flow through automatically without needing explicit handling.
 *
 * Does NOT split resources — callers handle that since different contexts need
 * different strategies (legacy strength merging vs passthrough).
 */
export function mapDataToGraphInput(
  params: Record<string, unknown>,
  enrichedResources: GenerationResource[],
  options?: { stepType?: string }
): Record<string, unknown> {
  // Cast for typed field access (both ImageMetaProps and TextToImageParams
  // are Record<string, unknown> supersets with overlapping fields)
  const p = params as GeneratedImageStepMetadata['params'];

  // Infer ecosystem first — needed for workflow resolution
  const ecosystem = inferBaseModel(p, enrichedResources);

  // Count images from params
  const imageCount = p?.images?.length ?? (p?.sourceImage ? 1 : 0);

  // Resolve workflow from step type + params + ecosystem context
  const workflow = resolveWorkflow(options?.stepType, p, ecosystem, imageCount);

  // Build aspect ratio from width/height in graph format { value, width, height }
  let aspectRatio: { value: string; width: number; height: number } | string | undefined;

  // Flux Ultra uses its own aspect ratio set
  if (p?.fluxUltraAspectRatio) {
    const dims = FLUX_ULTRA_ASPECT_RATIOS[p.fluxUltraAspectRatio];
    if (dims) {
      aspectRatio = { value: p.fluxUltraAspectRatio, ...dims };
    }
  }

  // Fall back to standard width/height from params
  if (!aspectRatio && p?.width && p?.height) {
    const ratioValue = p.aspectRatio ?? `${p.width}:${p.height}`;
    aspectRatio = {
      value: ratioValue,
      width: p.width,
      height: p.height,
    };
  }

  // For video engines: preserve string aspectRatio when no width/height conversion is available
  if (!aspectRatio && p?.aspectRatio && typeof p.aspectRatio === 'string') {
    aspectRatio = p.aspectRatio;
  }

  // Build images from sourceImage or images array
  let images: { url: string; width: number; height: number }[] | undefined;
  if (p?.sourceImage) {
    images = [
      {
        url: p.sourceImage.url,
        width: p.sourceImage.width,
        height: p.sourceImage.height,
      },
    ];
  } else if (p?.images) {
    images = p.images.map((img) => ({
      url: img.url,
      width: img.width,
      height: img.height,
    }));
  }

  // Destructure consumed/internal fields and legacy-named fields;
  // pass everything else through so engine-specific params (duration,
  // enablePromptEnhancer, style, mode, resolution, etc.) flow automatically.
  const {
    // Consumed during computation above — don't pass through
    width: _w,
    height: _h,
    sourceImage: _si,
    fluxUltraAspectRatio: _fuar,
    // Internal fields used for inference/resolution, not graph nodes
    process: _process,
    engine: _engine,
    fluxMode: _fluxMode,
    // Legacy field names that map to different graph node keys
    openAITransparentBackground,
    openAIQuality,
    baseModel: _legacyBaseModel, // Legacy field - mapped to 'ecosystem' below
    // Overridden by computed values below
    workflow: _wf,
    aspectRatio: _ar,
    images: _imgs,
    transformations: _transformations,
    ...rest
  } = params;

  // Map transformations (legacy 'type' → 'workflow')
  const mappedTransformations = mapTransformations(
    _transformations as Array<Record<string, unknown>>
  );

  return removeEmpty({
    ...rest,
    workflow,
    ecosystem, // Maps from legacy 'baseModel' field
    aspectRatio,
    images,
    transformations: mappedTransformations,
    // Map legacy field names to graph node keys
    ...(openAITransparentBackground != null && { transparent: openAITransparentBackground }),
    ...(openAIQuality != null && { quality: openAIQuality }),
  });
}

/**
 * Maps legacy step metadata to the new generation-graph input format.
 * Thin wrapper around mapDataToGraphInput that also handles resource splitting
 * with legacy strength merging and fluxMode model fallback.
 *
 * Handles backwards compatibility by mapping old 'baseModel' field to new 'ecosystem' field.
 *
 * @param step - The workflow step containing legacy metadata
 * @param enrichedResources - Full resource data looked up from the database
 * @returns Partial generation-graph input compatible with the new metadata.input format,
 *          or undefined if the step already uses the new format
 */
export function mapLegacyMetadata(
  step: WorkflowStep,
  enrichedResources: GenerationResource[]
): Partial<GenerationGraphCtx> | undefined {
  const metadata = (step.metadata ?? {}) as Record<string, unknown>;

  const legacyMetadata = metadata as GeneratedImageStepMetadata;
  const params = legacyMetadata.params;
  const legacyResources = legacyMetadata.resources ?? [];

  // Core param mapping (shared with getMediaGenerationData)
  const graphInput = mapDataToGraphInput(params ?? {}, enrichedResources, {
    stepType: step.$type,
  });

  // Resource splitting with legacy strength merging
  const split = splitResourcesForLegacy(enrichedResources, legacyResources);
  let { model } = split;
  const { resources, vae } = split;

  // If no checkpoint found from resources, try to infer model from fluxMode AIR
  if (!model && params?.fluxMode) {
    model = modelFromFluxModeAir(params.fluxMode);
  }

  // Cast needed: the return is a loose superset of fields from the discriminated union,
  // which doesn't match any single branch of Partial<GenerationGraphCtx> exactly.
  return {
    ...graphInput,
    model,
    resources,
    vae,
  } as Partial<GenerationGraphCtx>;
}

/**
 * Gets the generation input from a workflow step, handling both legacy and new formats.
 * Returns the input from metadata.input if present (new format), or maps from
 * legacy metadata.resources + metadata.params.
 *
 * @param step - The workflow step
 * @param enrichedResources - Full resource data (needed for legacy mapping)
 * @returns The generation input in the new format
 */
export function getGenerationInput(
  step: WorkflowStep,
  enrichedResources: GenerationResource[]
): Record<string, unknown> {
  const metadata = (step.metadata ?? {}) as Record<string, unknown>;

  // New format: metadata.input contains the full generation-graph output
  if (
    metadata.input &&
    typeof metadata.input === 'object' &&
    'workflow' in (metadata.input as object)
  ) {
    return metadata.input as Record<string, unknown>;
  }

  // Legacy format: map from resources + params
  return mapLegacyMetadata(step, enrichedResources) ?? {};
}

// =============================================================================
// Reverse Mapping: Graph → Legacy Format
// =============================================================================

/**
 * Maps generation-graph output to the legacy v1 form format.
 * This is the inverse of mapDataToGraphInput.
 *
 * Transforms:
 * - ecosystem → baseModel (for legacy compatibility)
 * - aspectRatio: { value, width, height } → string value
 * - images → sourceImage (first image)
 * - transparent → openAITransparentBackground
 * - quality → openAIQuality
 *
 * Resources should be handled separately using splitResourcesByType.
 *
 * @param graphOutput - The generation-graph output (without model/resources/vae)
 * @returns Params in legacy format for v1 form
 */
export function mapGraphToLegacyParams(
  graphOutput: Record<string, unknown>
): Record<string, unknown> {
  const {
    // Transform these fields
    ecosystem,
    aspectRatio,
    images,
    transparent,
    quality,
    fluxMode,
    workflow,
    // v2 DataGraph uses 'wanVersion'; legacy form uses 'version'
    wanVersion,
    // Pass through everything else
    ...rest
  } = graphOutput;

  // Decompose graph workflow keys into legacy format.
  // Graph uses colon-separated variants (txt2img:face-fix), legacy uses hyphens (txt2img-facefix).
  // mapDataToGraphInput strips 'process' (consumed to compute 'workflow'),
  // but legacy video forms (e.g. Wan, Vidu) need 'process' to distinguish txt2vid/img2vid.
  let legacyWorkflow = workflow;
  let process: string | undefined;
  let draft: boolean | undefined;
  if (typeof workflow === 'string') {
    // Map graph workflow keys back to comfy-format keys (colon → hyphen variants)
    if (workflow in WORKFLOW_TO_COMFY_KEY) {
      legacyWorkflow = WORKFLOW_TO_COMFY_KEY[workflow];
    }

    // Handle draft variant: 'txt2img:draft' → workflow='txt2img' + draft=true
    if (workflow === 'txt2img:draft') {
      legacyWorkflow = 'txt2img';
      draft = true;
    }

    // Restore process for video workflows.
    // ref2vid is a distinct process in the Vidu legacy form, not a variant of img2vid.
    const [base, variant] = workflow.split(':');
    if (['txt2vid', 'img2vid', 'vid2vid'].includes(base)) {
      process = variant === 'ref2vid' ? 'ref2vid' : base;
    }
  }

  // Restore 'engine' from ecosystem for video workflows.
  // mapDataToGraphInput strips 'engine', but legacy video schemas need it.
  const engine = typeof ecosystem === 'string' ? getEngineFromEcosystem(ecosystem) : undefined;

  // Map wanVersion → version for legacy Wan form compatibility.
  // The v2 DataGraph stores 'wanVersion', but the legacy form expects 'version'.
  const version = wanVersion ?? rest.version;
  if (wanVersion) delete rest.version; // avoid both fields

  // Convert aspectRatio object to string
  let aspectRatioValue: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  if (aspectRatio && typeof aspectRatio === 'object') {
    const ar = aspectRatio as { value?: string; width?: number; height?: number };
    aspectRatioValue = ar.value;
    width = ar.width;
    height = ar.height;
  } else if (typeof aspectRatio === 'string') {
    aspectRatioValue = aspectRatio;
  }

  // Convert images array to sourceImage for v1 image form (uses single sourceImage).
  // Also pass images array through for video forms which use it directly.
  let sourceImage: { url: string; width: number; height: number } | undefined;
  if (Array.isArray(images) && images.length > 0) {
    const firstImage = images[0] as { url?: string; width?: number; height?: number };
    if (firstImage.url) {
      sourceImage = {
        url: firstImage.url,
        width: firstImage.width ?? 512,
        height: firstImage.height ?? 512,
      };
    }
  }

  // Convert fluxMode from simple string to legacy AIR format
  // New format: 'draft', 'standard', 'pro', 'krea', 'ultra'
  // Legacy format: 'urn:air:flux1:checkpoint:civitai:618692@699279', etc.
  let legacyFluxMode: string | undefined;
  if (typeof fluxMode === 'string') {
    legacyFluxMode = FLUX_MODE_TO_AIR[fluxMode] ?? fluxMode;
  }

  // For Flux Ultra, convert aspectRatio value to legacy index format
  // New format: '21:9', '16:9', etc.
  // Legacy format: '0', '1', '2', etc. (index into fluxUltraAspectRatios array)
  let fluxUltraAspectRatio: string | undefined;
  if (fluxMode === 'ultra' && aspectRatioValue) {
    fluxUltraAspectRatio = FLUX_ULTRA_ASPECT_RATIO_TO_INDEX[aspectRatioValue];
  }

  return removeEmpty({
    ...rest,
    baseModel: ecosystem, // Map back to legacy field name
    workflow: legacyWorkflow,
    process,
    engine,
    version,
    draft,
    aspectRatio: aspectRatioValue,
    fluxUltraAspectRatio,
    width,
    height,
    sourceImage,
    images: Array.isArray(images) ? images : undefined, // Pass through for video forms
    fluxMode: legacyFluxMode,
    // Map back to legacy field names
    ...(transparent != null && { openAITransparentBackground: transparent }),
    ...(quality != null && { openAIQuality: quality }),
  });
}
