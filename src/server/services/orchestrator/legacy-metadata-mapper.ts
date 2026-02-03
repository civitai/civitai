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
import { workflowConfigs } from '~/shared/data-graph/generation/config/workflows';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { removeEmpty } from '~/utils/object-helpers';

// =============================================================================
// Workflow Mapping
// =============================================================================

/**
 * Maps old comfy workflow keys to new generation-graph workflow keys.
 * Old comfy keys use hyphens, new keys use colons as variant separators.
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

/**
 * Maps legacy video engine values to their baseModel/ecosystem key.
 * Used when params.baseModel is missing but params.engine is present.
 */
const ENGINE_TO_BASE_MODEL: Record<string, string> = {
  wan: 'WanVideo',
  vidu: 'Vidu',
  kling: 'Kling',
  hunyuan: 'HyV1',
  minimax: 'MiniMax',
  mochi: 'Mochi',
  sora: 'Sora2',
  veo3: 'Veo3',
  haiper: 'Haiper',
  lightricks: 'Lightricks',
};

/**
 * Checks if a baseModel key's ecosystem is listed in a workflow config's ecosystemIds.
 */
function ecosystemSupportsWorkflow(baseModel: string, workflowKey: string): boolean {
  const eco = ecosystemByKey.get(baseModel);
  if (!eco) return false;
  return (
    workflowConfigs[workflowKey as keyof typeof workflowConfigs]?.ecosystemIds.includes(eco.id) ??
    false
  );
}

/**
 * Refines an img2img process into the correct workflow variant.
 * Derives supported ecosystems from workflowConfigs rather than hardcoded sets.
 *
 * - Ecosystems in `img2img:edit` config → `img2img:edit`
 * - Ecosystems in `img2img` config → `img2img` (standard comfy-based)
 * - No inferable baseModel → `img2img:upscale` (likely standalone upscale)
 * - Other → `img2img`
 */
function resolveImg2ImgWorkflow(baseModel: string | undefined): string {
  if (!baseModel) return 'img2img:upscale';
  if (ecosystemSupportsWorkflow(baseModel, 'img2img:edit')) return 'img2img:edit';
  return 'img2img';
}

/**
 * Refines an img2vid process into the correct workflow variant.
 * Derives supported ecosystems from workflowConfigs rather than hardcoded sets.
 *
 * - Ecosystem in `img2vid:ref2vid` config + 3+ images → `img2vid:ref2vid`
 * - Ecosystem in `img2vid:first-last-frame` config + 2 images → `img2vid:first-last-frame`
 * - Other → `img2vid`
 */
function resolveImg2VidWorkflow(baseModel: string | undefined, imageCount: number): string {
  if (baseModel) {
    if (imageCount >= 3 && ecosystemSupportsWorkflow(baseModel, 'img2vid:ref2vid')) {
      return 'img2vid:ref2vid';
    }
    if (imageCount === 2 && ecosystemSupportsWorkflow(baseModel, 'img2vid:first-last-frame')) {
      return 'img2vid:first-last-frame';
    }
  }
  return 'img2vid';
}

/**
 * Determines the workflow key from legacy params, step type, and ecosystem context.
 *
 * Priority:
 * 1. Comfy workflow key from params.workflow (if $type is 'comfy')
 * 2. Draft detection from params.draft
 * 3. params.workflow if already in new format (contains variant separator)
 * 4. params.process refined by ecosystem context
 * 5. Source image detection → img2img refined by ecosystem
 * 6. Fallback → txt2img
 */
export function resolveWorkflow(
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

  // 3. If workflow already has a variant separator, use it directly
  if (params.workflow?.includes(':')) {
    return params.workflow;
  }

  // 4. Determine base process and refine with ecosystem context
  const process = params.process ?? params.workflow;
  if (process) {
    switch (process) {
      case 'img2img':
        return resolveImg2ImgWorkflow(baseModel);
      case 'img2vid':
        return resolveImg2VidWorkflow(baseModel, imageCount);
      case 'txt2img':
      case 'txt2vid':
        return process;
      default:
        return process;
    }
  }

  // 5. Infer from source images
  if (params.sourceImage || params.images) {
    return resolveImg2ImgWorkflow(baseModel);
  }

  // 6. Fallback
  return 'txt2img';
}

// =============================================================================
// BaseModel Inference
// =============================================================================

/**
 * Infers the baseModel/ecosystem key when params.baseModel is missing.
 *
 * Priority:
 * 1. params.baseModel (already present)
 * 2. params.engine → ENGINE_TO_BASE_MODEL lookup
 * 3. Enriched resources → getBaseModelFromResources (checkpoint baseModel → group)
 */
export function inferBaseModel(
  params: GeneratedImageStepMetadata['params'],
  enrichedResources: GenerationResource[]
): string | undefined {
  // 1. Direct from params
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
// Public API
// =============================================================================

/**
 * Maps raw generation params + enriched resources into graph-compatible input.
 *
 * Passes through all params by default, only transforming fields that need it:
 * - Computes `workflow` (from stepType + params + baseModel)
 * - Computes `baseModel` (from params + resources)
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

  // Infer baseModel first — needed for workflow resolution
  const baseModel = inferBaseModel(p, enrichedResources);

  // Count images from params
  const imageCount = p?.images?.length ?? (p?.sourceImage ? 1 : 0);

  // Resolve workflow from step type + params + ecosystem context
  const workflow = resolveWorkflow(options?.stepType, p, baseModel, imageCount);

  // Build aspect ratio from width/height in graph format { value, width, height }
  let aspectRatio: { value: string; width: number; height: number } | undefined;

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
    // Overridden by computed values below
    workflow: _wf,
    baseModel: _bm,
    aspectRatio: _ar,
    images: _imgs,
    ...rest
  } = params;

  return removeEmpty({
    ...rest,
    workflow,
    baseModel,
    aspectRatio,
    images,
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
    aspectRatio,
    images,
    transparent,
    quality,
    // Pass through everything else
    ...rest
  } = graphOutput;

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

  // Convert images array to sourceImage (v1 form uses single sourceImage)
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

  return removeEmpty({
    ...rest,
    aspectRatio: aspectRatioValue,
    width,
    height,
    sourceImage,
    // Map back to legacy field names
    ...(transparent != null && { openAITransparentBackground: transparent }),
    ...(quality != null && { openAIQuality: quality }),
  });
}
