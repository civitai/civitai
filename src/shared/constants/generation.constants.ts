import type { WorkflowStatus } from '@civitai/client';
import type {
  ComfySampler,
  ComfyScheduler,
  SdCppSampleMethod,
  SdCppSchedule,
} from '@civitai/orchestration-client';
import { Scheduler } from '@civitai/client';
import type { MantineColor } from '@mantine/core';
import type { Sampler } from '~/server/common/constants';
import {
  generation,
  generationConfig,
  getGenerationConfig,
  maxUpscaleSize,
  minDownscaleSize,
  maxRandomSeed,
} from '~/server/common/constants';
import type { GenerationLimits } from '~/server/schema/generation.schema';
import type { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import type { WorkflowDefinition } from '~/server/services/orchestrator/types';
import type { BaseModelGroup } from '~/shared/constants/basemodel.constants';
import {
  getBaseModelGroup,
  getBaseModelMediaType,
  getResourceGenerationSupport,
} from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import {
  MEGAPIXEL,
  findClosestAspectRatio,
  type CustomDimensionLimits,
} from '~/utils/aspect-ratio-helpers';
import { findClosest, getRatio } from '~/utils/number-helpers';

// Response header the orchestrator router sets when the generation client is behind; UpdateRequiredWatcher
// reads it to prompt a refresh. (Rehomed from the deleted auth.constants.ts — it's a generation signal.)
export const GENERATION_UPDATE_HEADER = 'x-generation-update-required';

// =============================================================================
// Seed Constants
// =============================================================================

/** Maximum seed value that can be input (unsigned 32-bit integer max) */
export const MAX_SEED = 4294967295;

/** Maximum seed value for random generation (signed 32-bit integer max) */
export { maxRandomSeed as MAX_RANDOM_SEED };

// =============================================================================
// Workflow Tags
// =============================================================================

export const WORKFLOW_TAGS = {
  GENERATION: 'gen',
  IMAGE: 'img',
  VIDEO: 'vid',
  AUDIO: 'aud',
  FAVORITE: 'favorite',
  FOLDER: 'folder',
  WILDCARDS: 'wildcards',
  FEEDBACK: {
    LIKED: 'feedback:liked',
    DISLIKED: 'feedback:disliked',
  },
  // Source form identifiers
  SOURCE: {
    LEGACY: 'source:legacy',
    NEW: 'source:new',
  },
  // Process types for filtering
  PROCESS: {
    // Image processes
    TXT2IMG: 'process:txt2img',
    IMG2IMG: 'process:img2img',
    UPSCALE: 'process:upscale',
    BACKGROUND_REMOVAL: 'process:bg-removal',
    // Video processes
    TXT2VID: 'process:txt2vid',
    IMG2VID: 'process:img2vid',
    VID_UPSCALE: 'process:vid-upscale',
    VID_INTERPOLATION: 'process:vid-interpolation',
    VID_ENHANCEMENT: 'process:vid-enhancement',
    // Audio processes
    TXT2MUSIC: 'process:txt2music',
  },
};

/**
 * Derives the process tag from workflow ID and source image presence.
 * Used to add consistent process tags to workflows for filtering.
 */
export function getProcessTagFromWorkflow(
  workflow: string,
  hasSourceImage: boolean,
  mediaType: 'image' | 'video' | 'audio' = 'image'
): string {
  // Check for specific workflow types first
  if (workflow.includes('background-removal')) return WORKFLOW_TAGS.PROCESS.BACKGROUND_REMOVAL;
  if (workflow.includes('upscale') && mediaType === 'video')
    return WORKFLOW_TAGS.PROCESS.VID_UPSCALE;
  if (workflow.includes('upscale')) return WORKFLOW_TAGS.PROCESS.UPSCALE;
  if (workflow.includes('interpolation')) return WORKFLOW_TAGS.PROCESS.VID_INTERPOLATION;
  if (workflow.includes('enhancement') && mediaType === 'video')
    return WORKFLOW_TAGS.PROCESS.VID_ENHANCEMENT;

  // Audio workflows
  if (mediaType === 'audio') {
    return WORKFLOW_TAGS.PROCESS.TXT2MUSIC;
  }

  // Default based on media type and source image
  if (mediaType === 'video') {
    return hasSourceImage ? WORKFLOW_TAGS.PROCESS.IMG2VID : WORKFLOW_TAGS.PROCESS.TXT2VID;
  }
  return hasSourceImage ? WORKFLOW_TAGS.PROCESS.IMG2IMG : WORKFLOW_TAGS.PROCESS.TXT2IMG;
}

/** Process type options for filter UI */
export const PROCESS_TYPE_OPTIONS = [
  // Image processes
  { value: WORKFLOW_TAGS.PROCESS.TXT2IMG, label: 'Text to Image' },
  { value: WORKFLOW_TAGS.PROCESS.IMG2IMG, label: 'Image to Image' },
  { value: WORKFLOW_TAGS.PROCESS.UPSCALE, label: 'Upscale' },
  { value: WORKFLOW_TAGS.PROCESS.BACKGROUND_REMOVAL, label: 'Background Removal' },
  // Video processes
  { value: WORKFLOW_TAGS.PROCESS.TXT2VID, label: 'Text to Video' },
  { value: WORKFLOW_TAGS.PROCESS.IMG2VID, label: 'Image to Video' },
  { value: WORKFLOW_TAGS.PROCESS.VID_UPSCALE, label: 'Video Upscale' },
  { value: WORKFLOW_TAGS.PROCESS.VID_INTERPOLATION, label: 'Interpolation' },
  { value: WORKFLOW_TAGS.PROCESS.VID_ENHANCEMENT, label: 'Enhancement' },
  // Audio processes
  { value: WORKFLOW_TAGS.PROCESS.TXT2MUSIC, label: 'Text to Music' },
] as const;

export const generationServiceCookie = {
  name: 'generation-token',
  maxAge: 3600,
};

// #region [statuses]
export const generationStatusColors: Record<WorkflowStatus, MantineColor> = {
  unassigned: 'yellow',
  preparing: 'yellow',
  scheduled: 'yellow',
  processing: 'yellow',
  succeeded: 'green',
  failed: 'red',
  expired: 'gray',
  canceled: 'gray',
};

export const orchestratorRefundableStatuses: WorkflowStatus[] = ['failed', 'expired', 'canceled'];
export const orchestratorCompletedStatuses: WorkflowStatus[] = [
  ...orchestratorRefundableStatuses,
  'succeeded',
];
export const orchestratorPendingStatuses: WorkflowStatus[] = [
  'unassigned',
  'preparing',
  'scheduled',
];
// #endregion

// #region [draft mode]
export const DRAFT_WORKFLOW = 'txt2img:draft';

type SliderRange = { min: number; max: number; default: number };

/**
 * SD's `txt2img:draft`: an accelerator LoRA the server adds unseen, and the steps/CFG range and
 * sampler it is trained for.
 */
export type SdDraftMode = {
  loraVersionId: number;
  /** Pre-computed: the LoRA is never one of the user's resources, so it has no resolved AIR. */
  air: string;
  sampler: Sampler;
  steps: SliderRange;
  cfgScale: SliderRange;
};

const sdxlDraftMode: SdDraftMode = {
  loraVersionId: 391999, // SDXL Lightning LoRAs — 8 Steps
  air: 'urn:air:sdxl:lora:civitai:350450@391999',
  sampler: 'Euler',
  steps: { min: 4, max: 12, default: 8 },
  cfgScale: { min: 1, max: 2, default: 1 },
};

const sd1DraftMode: SdDraftMode = {
  loraVersionId: 424706, // LCM-LoRA for SD 1.5
  air: 'urn:air:sd1:lora:civitai:195519@424706',
  sampler: 'LCM',
  steps: { min: 4, max: 8, default: 6 },
  cfgScale: { min: 1, max: 2, default: 1 },
};

/** SD1 has its own LoRA; every other SD-family ecosystem uses SDXL's. */
export function getSdDraftMode(ecosystem: string | undefined): SdDraftMode {
  return ecosystem === 'SD1' ? sd1DraftMode : sdxlDraftMode;
}

export const clampToRange = (value: number | undefined, range: SliderRange) =>
  Math.min(range.max, Math.max(range.min, value ?? range.default));

/** Kept out of model metrics and stripped from remixes: the user never chose these LoRAs. */
export const allInjectableResourceIds = [sdxlDraftMode, sd1DraftMode].map((x) => x.loraVersionId);
// #endregion

export const whatIfQueryOverrides = {
  prompt: '',
  negativePrompt: '',
  seed: null,
  // image: undefined,
  nsfw: false,
  cfgScale: generation.defaultValues.cfgScale,
  remixSimilarity: 1,
};

export const samplers = [
  'Euler a',
  'Euler',
  'Heun',
  'LMS',
  'DDIM',
  'DPM++ 2M Karras',
  'DPM2',
  'DPM2 a',
] as const;

export const samplersToSchedulers = {
  'Euler a': Scheduler.EULER_A,
  Euler: Scheduler.EULER,
  LMS: Scheduler.LMS,
  Heun: Scheduler.HEUN,
  DPM2: Scheduler.DP_M2,
  'DPM2 a': Scheduler.DP_M2A,
  'DPM++ 2S a': Scheduler.DP_M2SA,
  'DPM++ 2M': Scheduler.DP_M2M,
  // 'DPM++ 2M SDE': 'DPM2MSDE',
  'DPM++ SDE': Scheduler.DPMSDE,
  'DPM fast': Scheduler.DPM_FAST,
  'DPM adaptive': Scheduler.DPM_ADAPTIVE,
  'LMS Karras': Scheduler.LMS_KARRAS,
  'DPM2 Karras': Scheduler.DP_M2_KARRAS,
  'DPM2 a Karras': Scheduler.DP_M2A_KARRAS,
  'DPM++ 2S a Karras': Scheduler.DP_M2SA_KARRAS,
  'DPM++ 2M Karras': Scheduler.DP_M2M_KARRAS,
  // 'DPM++ 2M SDE Karras': 'DPM2MSDEKarras',
  'DPM++ SDE Karras': Scheduler.DPMSDE_KARRAS,
  'DPM++ 3M SDE': Scheduler.DP_M3MSDE,
  // 'DPM++ 3M SDE Karras': 'DPM3MSDEKarras',
  // 'DPM++ 3M SDE Exponential': 'DPM3MSDEExponential',
  DDIM: Scheduler.DDIM,
  PLMS: Scheduler.PLMS,
  UniPC: Scheduler.UNI_PC,
  LCM: Scheduler.LCM,
  undefined: Scheduler.UNDEFINED,
} as const as Record<Sampler | 'undefined', Scheduler>;

export const generationSamplers = Object.keys(samplersToSchedulers) as Sampler[];

// !important - undefined maps to the same values as 'DPM++ 2M Karras'
export const samplersToComfySamplers: Record<
  Sampler | 'undefined',
  { sampler: ComfySampler; scheduler: ComfyScheduler }
> = {
  'Euler a': { sampler: 'euler_ancestral', scheduler: 'normal' },
  Euler: { sampler: 'euler', scheduler: 'normal' },
  LMS: { sampler: 'lms', scheduler: 'normal' },
  Heun: { sampler: 'heun', scheduler: 'normal' },
  DPM2: { sampler: 'dpm_2', scheduler: 'normal' },
  'DPM2 a': { sampler: 'dpm_2_ancestral', scheduler: 'normal' },
  'DPM++ 2S a': { sampler: 'dpmpp_2s_ancestral', scheduler: 'normal' },
  'DPM++ 2M': { sampler: 'dpmpp_2m', scheduler: 'normal' },
  'DPM++ 2M SDE': { sampler: 'dpmpp_2m_sde', scheduler: 'normal' },
  'DPM++ SDE': { sampler: 'dpmpp_sde', scheduler: 'normal' },
  'DPM fast': { sampler: 'dpm_fast', scheduler: 'normal' },
  'DPM adaptive': { sampler: 'dpm_adaptive', scheduler: 'normal' },
  'LMS Karras': { sampler: 'lms', scheduler: 'karras' },
  'DPM2 Karras': { sampler: 'dpm_2', scheduler: 'karras' },
  'DPM2 a Karras': { sampler: 'dpm_2_ancestral', scheduler: 'karras' },
  'DPM++ 2S a Karras': { sampler: 'dpmpp_2s_ancestral', scheduler: 'karras' },
  'DPM++ 2M Karras': { sampler: 'dpmpp_2m', scheduler: 'karras' },
  'DPM++ 2M SDE Karras': { sampler: 'dpmpp_2m_sde', scheduler: 'karras' },
  'DPM++ SDE Karras': { sampler: 'dpmpp_sde', scheduler: 'karras' },
  'DPM++ 3M SDE': { sampler: 'dpmpp_3m_sde', scheduler: 'normal' },
  'DPM++ 3M SDE Karras': { sampler: 'dpmpp_3m_sde', scheduler: 'karras' },
  'DPM++ 3M SDE Exponential': { sampler: 'dpmpp_3m_sde', scheduler: 'exponential' },
  DDIM: { sampler: 'ddim', scheduler: 'normal' },
  PLMS: { sampler: 'ddim', scheduler: 'normal' },
  UniPC: { sampler: 'uni_pc', scheduler: 'normal' },
  LCM: { sampler: 'lcm', scheduler: 'normal' },
  undefined: { sampler: 'dpmpp_2m', scheduler: 'karras' },
};

// stable-diffusion.cpp ships a smaller sampler set than ComfyUI: LMS, the SDE variants,
// DPM fast/adaptive, UniPC and PLMS have no equivalent and collapse onto the nearest
// family member, so a user's sampler choice is not always preserved across this map.
export const samplersToSdCppSamplers: Record<
  Sampler | 'undefined',
  { sampleMethod: SdCppSampleMethod; schedule: SdCppSchedule }
> = {
  'Euler a': { sampleMethod: 'euler_a', schedule: 'discrete' },
  Euler: { sampleMethod: 'euler', schedule: 'discrete' },
  LMS: { sampleMethod: 'euler', schedule: 'discrete' },
  Heun: { sampleMethod: 'heun', schedule: 'discrete' },
  DPM2: { sampleMethod: 'dpm2', schedule: 'discrete' },
  'DPM2 a': { sampleMethod: 'dpm++2s_a', schedule: 'discrete' },
  'DPM++ 2S a': { sampleMethod: 'dpm++2s_a', schedule: 'discrete' },
  'DPM++ 2M': { sampleMethod: 'dpm++2m', schedule: 'discrete' },
  'DPM++ 2M SDE': { sampleMethod: 'dpm++2mv2', schedule: 'discrete' },
  'DPM++ SDE': { sampleMethod: 'dpm++2mv2', schedule: 'discrete' },
  'DPM fast': { sampleMethod: 'euler', schedule: 'discrete' },
  'DPM adaptive': { sampleMethod: 'euler', schedule: 'discrete' },
  'LMS Karras': { sampleMethod: 'euler', schedule: 'karras' },
  'DPM2 Karras': { sampleMethod: 'dpm2', schedule: 'karras' },
  'DPM2 a Karras': { sampleMethod: 'dpm++2s_a', schedule: 'karras' },
  'DPM++ 2S a Karras': { sampleMethod: 'dpm++2s_a', schedule: 'karras' },
  'DPM++ 2M Karras': { sampleMethod: 'dpm++2m', schedule: 'karras' },
  'DPM++ SDE Karras': { sampleMethod: 'dpm++2mv2', schedule: 'karras' },
  'DPM++ 2M SDE Karras': { sampleMethod: 'dpm++2mv2', schedule: 'karras' },
  'DPM++ 3M SDE': { sampleMethod: 'dpm++2mv2', schedule: 'discrete' },
  'DPM++ 3M SDE Karras': { sampleMethod: 'dpm++2mv2', schedule: 'karras' },
  'DPM++ 3M SDE Exponential': { sampleMethod: 'dpm++2mv2', schedule: 'exponential' },
  DDIM: { sampleMethod: 'ddim_trailing', schedule: 'discrete' },
  PLMS: { sampleMethod: 'ddim_trailing', schedule: 'discrete' },
  UniPC: { sampleMethod: 'dpm++2m', schedule: 'discrete' },
  LCM: { sampleMethod: 'lcm', schedule: 'lcm' },
  undefined: { sampleMethod: 'dpm++2m', schedule: 'karras' },
};

// #region [utils]
export function getBaseModelSetType(baseModel?: string, defaultType: BaseModelGroup = 'SD1') {
  if (!baseModel) return defaultType;
  return getBaseModelGroup(baseModel ?? defaultType);
}

export function getIsSdxl(baseModel?: string) {
  return baseModel ? getBaseModelSetType(baseModel) === 'SDXL' : false;
}

export function getIsHiDream(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'HiDream';
}

export function getIsFlux(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'Flux1' || baseModelSetType === 'FluxKrea';
}

export function getIsFluxStandard(modelId: number) {
  return modelId === fluxStandardModelId;
}

export function getIsSD3(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'SD3' || baseModelSetType === 'SD3_5M';
}

export function getIsQwen(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'Qwen';
}

export function getIsChroma(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'Chroma';
}

export function getIsFlux2(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'Flux2';
}

export function getIsZImageTurbo(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'ZImageTurbo';
}

export function getIsZImageBase(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'ZImageBase';
}

export function getBaseModelFromResources<T extends { modelType: ModelType; baseModel: string }>(
  resources: T[]
): BaseModelGroup | undefined {
  const checkpoint = resources.find((x) => x.modelType === 'Checkpoint');
  if (checkpoint) return getBaseModelGroup(checkpoint.baseModel);

  if (resources.length === 0) return undefined;

  // Get ecosystem groups for each resource, excluding 'Other' (unresolvable)
  const resourceGroups = resources
    .map((x) => getBaseModelGroup(x.baseModel))
    .filter((g): g is string => g !== undefined && g !== 'Other');

  if (resourceGroups.length === 0) return undefined;

  // If all resources map to the same group, use it directly
  const uniqueGroups = [...new Set(resourceGroups)];
  if (uniqueGroups.length === 1) return uniqueGroups[0];

  // Multiple groups: score each candidate by how many resources are compatible with it.
  // On tie, the first group encountered wins (preserves resource order intent).
  let bestGroup = uniqueGroups[0];
  let bestScore = 0;

  for (const candidateGroup of uniqueGroups) {
    let score = 0;
    for (const resource of resources) {
      const support = getResourceGenerationSupport(
        candidateGroup,
        resource.baseModel,
        resource.modelType
      );
      if (support !== null) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestGroup = candidateGroup;
    }
  }

  return bestGroup;
}

export function getBaseModelFromResourcesWithDefault<
  T extends { modelType: ModelType; baseModel: string }
>(resources: T[]) {
  return getBaseModelFromResources(resources) ?? 'SD1';
}

export function getResourceGenerationType(
  baseModel: ReturnType<typeof getBaseModelFromResourcesWithDefault>
) {
  return getBaseModelMediaType(baseModel);
}

export function sanitizeTextToImageParams<T extends Partial<TextToImageParams>>(
  params: T,
  limits?: GenerationLimits
) {
  // if (params.sampler) {
  //   params.sampler = (generation.samplers as string[]).includes(params.sampler)
  //     ? params.sampler
  //     : generation.defaultValues.sampler;
  // }

  const maxValueKeys = Object.keys(generation.maxValues);
  for (const item of maxValueKeys) {
    const key = item as keyof typeof generation.maxValues;
    if (params[key]) params[key] = Math.min(params[key] ?? 0, generation.maxValues[key]);
  }

  if (!params.aspectRatio && params.width && params.height) {
    params.aspectRatio = getClosestAspectRatio(params.width, params.height, params.baseModel);
    if (getIsFlux(params.baseModel))
      params.fluxUltraAspectRatio = getClosestFluxUltraAspectRatio(params.width, params.height);
  }

  // handle SDXL ClipSkip
  // I was made aware that SDXL only works with clipSkip 2
  // if that's not the case anymore, we can rollback to just setting
  // this for Pony resources -Manuel
  const isSDXL = getIsSdxl(params.baseModel);
  if (isSDXL) params.clipSkip = 2;

  if (limits) {
    if (params.steps) params.steps = Math.min(params.steps, 50);
    if (params.quantity) params.quantity = Math.min(params.quantity, limits.quantity);
  }
  return params;
}

export function getSizeFromAspectRatio(
  aspectRatio: string,
  baseModel?: string,
  modelVersionId?: number
) {
  const aspectRatios = getGenerationConfig(baseModel, modelVersionId).aspectRatios;

  return (
    aspectRatios.find((x) => getRatio(x.width, x.height) === aspectRatio) ??
    generationConfig.SD1.aspectRatios[0]
  );
}

export const getClosestAspectRatio = (width?: number, height?: number, baseModel?: string) => {
  width = width ?? (baseModel === 'SDXL' ? 1024 : 512);
  height = height ?? (baseModel === 'SDXL' ? 1024 : 512);
  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  const result = findClosestAspectRatio({ width, height }, aspectRatios) ?? aspectRatios[0];
  return result ? getRatio(result.width, result.height) : '1:1';
};

export function getWorkflowDefinitionFeatures(workflow?: {
  features?: WorkflowDefinition['features'];
}) {
  return {
    draft: workflow?.features?.includes('draft') ?? false,
    denoise: workflow?.features?.includes('denoise') ?? false,
    upscaleWidth: workflow?.features?.includes('upscale') ?? false,
    upscaleHeight: workflow?.features?.includes('upscale') ?? false,
    image: workflow?.features?.includes('image') ?? false,
  };
}

export function sanitizeParamsByWorkflowDefinition(
  params: TextToImageParams,
  workflow?: {
    features?: WorkflowDefinition['features'];
  }
) {
  const features = getWorkflowDefinitionFeatures(workflow);
  for (const key in features) {
    if (!features[key as keyof typeof features]) delete (params as any)[key];
  }
}

// #endregion

// #region [config]
export const miscModelTypes: ModelType[] = [
  'AestheticGradient',
  'Hypernetwork',
  'Controlnet',
  'Upscaler',
  'MotionModule',
  'Poses',
  'Wildcards',
  'Workflows',
  'ComfyWorkflows',
  'Detection',
  'VisionLanguage',
  'CLIP',
  'LLM',
  'Other',
] as const;

const fluxStandardModelId = 618692;
export const fluxStandardAir = 'urn:air:flux1:checkpoint:civitai:618692@691639';
export const fluxUltraAir = 'urn:air:flux1:checkpoint:civitai:618692@1088507';
export const fluxDraftAir = 'urn:air:flux1:checkpoint:civitai:618692@699279';
export const fluxKreaAir = 'urn:air:flux1:checkpoint:civitai:618692@2068000';
export const fluxUltraAirId = 1088507;
export const fluxProAirId = 922358;
export const ponyV7Air = 'urn:air:auraflow:checkpoint:civitai:1901521@2152373';

// Ecosystems that expose the `enhancedCompatibility` toggle — txt2img only.
// Off (the default) runs sdcpp; on runs comfy. Pony/Illustrious/NoobAI are SDXL derivatives and
// stay on sdcpp with SDXL.
export const EXPERIMENTAL_MODE_SUPPORTED_MODELS: string[] = [
  'SD1',
  'SDXL',
  'Pony',
  'Illustrious',
  'NoobAI',
];

// Ecosystems that qualify for the 2-for-1 quantity bonus + footer alert. Historical name: membership
// is a pricing decision, not "runs on sdcpp" (Flux2Klein submits 'flux2').
export const SDCPP_SUPPORTED_ECOSYSTEMS: string[] = [
  ...EXPERIMENTAL_MODE_SUPPORTED_MODELS,
  'Flux2Klein_9B',
  'Flux2Klein_9B_base',
  'Flux2Klein_4B',
  'Flux2Klein_4B_base',
];

// Flux Pro 1.1 / Ultra: excluded from the sdcpp 2-for-1 bonus and its footer alert.
export const SDCPP_EXCLUDED_MODEL_IDS: number[] = [fluxProAirId, fluxUltraAirId];

export function usesComfyEngine({
  ecosystem,
  enhancedCompatibility,
}: {
  ecosystem: string;
  enhancedCompatibility?: boolean;
}): boolean {
  return EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(ecosystem) && enhancedCompatibility === true;
}

// Per-tier per-request video quantity for ecosystems that batch multiple
// outputs in a single job. Drives `ext.limits.vidQuantity` and the quantity
// node max for those ecosystems. Founder treated as gold so legacy paid
// members retain the highest cap.
export const VID_QUANTITY_BY_TIER: Record<
  'free' | 'founder' | 'bronze' | 'silver' | 'gold',
  number
> = {
  free: 1,
  founder: 2,
  bronze: 2,
  silver: 3,
  gold: 4,
};
export const VID_MAX_QUANTITY = Math.max(...Object.values(VID_QUANTITY_BY_TIER));

// Ecosystems whose engine produces several videos from one job (Seed +
// slotIndex), so the quantity node applies to video output and the tier cap
// is worth upselling against.
export const VID_QUANTITY_ECOSYSTEMS = new Set<string>(['LTXV23', 'LTXV25']);
export const fluxModeOptions = [
  { label: 'Draft', value: fluxDraftAir },
  { label: 'Standard', value: fluxStandardAir },
  // { label: 'Pro', value: 'urn:air:flux1:checkpoint:civitai:618692@699332' },
  { label: 'Krea', value: fluxKreaAir },
  { label: 'Pro 1.1', value: 'urn:air:flux1:checkpoint:civitai:618692@922358' },
  { label: 'Ultra', value: fluxUltraAir },
];

// #endregion

// #region [workflows]

// =============================================================================
// Aspect Ratio Dimensions by Resolution Tier
// =============================================================================

/**
 * Resolution tiers used across generation ecosystems.
 * - 480p / 720p / 1080p: video tiers (short side ≈ named pixels)
 * - 2K / 4K: image tiers (long side ≈ 2560 / 4096)
 */
export type GenerationResolution = '480p' | '720p' | '1080p' | '2K' | '4K';

export type GenerationAspectRatio =
  | '21:9'
  | '16:9'
  | '3:2'
  | '5:4'
  | '4:3'
  | '1:1'
  | '3:4'
  | '4:5'
  | '2:3'
  | '9:16';

export type AspectRatioDimensions = { width: number; height: number };

/**
 * Canonical width/height for each (resolution, aspect ratio) pair, shared across
 * generation ecosystems so the form displays consistent dimensions.
 *
 * 2K / 4K values match the dimensions Seedream's API expects; video-tier values
 * are display-only (the orchestrator derives actual dimensions from the
 * aspectRatio + resolution pair sent in the payload).
 */
export const aspectRatioDimensions: Record<
  GenerationResolution,
  Partial<Record<GenerationAspectRatio, AspectRatioDimensions>>
> = {
  '480p': {
    '21:9': { width: 1344, height: 576 },
    '16:9': { width: 848, height: 480 },
    '3:2': { width: 720, height: 480 },
    '5:4': { width: 608, height: 480 },
    '4:3': { width: 640, height: 480 },
    '1:1': { width: 480, height: 480 },
    '3:4': { width: 480, height: 640 },
    '4:5': { width: 384, height: 480 },
    '2:3': { width: 480, height: 720 },
    '9:16': { width: 480, height: 848 },
  },
  '720p': {
    '21:9': { width: 2016, height: 864 },
    '16:9': { width: 1280, height: 720 },
    '3:2': { width: 1080, height: 720 },
    '5:4': { width: 912, height: 720 },
    '4:3': { width: 960, height: 720 },
    '1:1': { width: 720, height: 720 },
    '3:4': { width: 720, height: 960 },
    '4:5': { width: 576, height: 720 },
    '2:3': { width: 720, height: 1080 },
    '9:16': { width: 720, height: 1280 },
  },
  '1080p': {
    '21:9': { width: 3024, height: 1296 },
    '16:9': { width: 1920, height: 1080 },
    '3:2': { width: 1620, height: 1080 },
    '5:4': { width: 1344, height: 1080 },
    '4:3': { width: 1440, height: 1080 },
    '1:1': { width: 1080, height: 1080 },
    '3:4': { width: 1080, height: 1440 },
    '4:5': { width: 864, height: 1080 },
    '2:3': { width: 1080, height: 1620 },
    '9:16': { width: 1080, height: 1920 },
  },
  '2K': {
    '21:9': { width: 3360, height: 1440 },
    '16:9': { width: 2560, height: 1440 },
    '4:3': { width: 2304, height: 1728 },
    '1:1': { width: 2048, height: 2048 },
    '3:4': { width: 1728, height: 2304 },
    '9:16': { width: 1440, height: 2560 },
  },
  '4K': {
    '16:9': { width: 4096, height: 2304 },
    '4:3': { width: 4096, height: 3072 },
    '1:1': { width: 4096, height: 4096 },
    '3:4': { width: 3072, height: 4096 },
    '9:16': { width: 2304, height: 4096 },
  },
};

/**
 * Diffusion training aspect ratio buckets — fixed width/height pairs picked to
 * keep total pixel area near a target while staying divisible by 64 (the U-Net
 * stride requirement). These are model-architecture values, not derivable by
 * scaling a clean ratio.
 */

/** The SDXL training bucket set (~1024² area, /64 aligned), widest to tallest —
 * the order AspectRatioInput displays in. Used by every ~1M-pixel diffusion
 * ecosystem: SDXL, Pony, Illustrious, NoobAI, Pony v7, Anima, Chroma, Flux.1
 * (comfy modes), Flux.2, Flux.2 Klein, Hi-Dream, Z-Image, Boogu and Ideogram.
 * Each of those inputs takes any width/height up to 2048 divisible by 16
 * (Flux.2 and Klein from 512), so all nine fit. Labels are approximate, the
 * same way 832×1216 is called 2:3. */
export const sdxlFullAspectRatioBuckets = [
  { label: '21:9', value: '21:9', width: 1536, height: 640 },
  { label: '16:9', value: '16:9', width: 1344, height: 768 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
  { label: '4:3', value: '4:3', width: 1152, height: 896 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:4', value: '3:4', width: 896, height: 1152 },
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '9:16', value: '9:16', width: 768, height: 1344 },
  { label: '9:21', value: '9:21', width: 640, height: 1536 },
];

/** Flux.1 Pro (BFL `flux1-pro`) caps each side at 1440 (/32), so the 1536-long
 * 21:9 and 9:21 buckets are out. */
export const flux1ProAspectRatioBuckets = sdxlFullAspectRatioBuckets.filter(
  (b) => b.width <= 1440 && b.height <= 1440
);

/**
 * The `value` of a custom width × height, in place of a ratio label. An explicit
 * marker, not "any size that isn't a bucket": remix and legacy metadata send a
 * source image's raw size, which must keep snapping to the nearest bucket.
 */
export const CUSTOM_ASPECT_RATIO = 'custom';

/**
 * Custom width × height, grouped by what each model's authors document (model
 * cards, papers, BFL's docs — checked 2026-10-01): ~1, ~2 and ~4 MP, plus Flux.1
 * Pro and SD1. The engines accept 64–2048 /16 (Flux.2 and Klein from 512;
 * flux1-pro 256–1440 /32); these are tighter on purpose: /32
 * steps, sides from 512, and 2.5:1 at most, which covers the 21:9 bucket
 * (1536×640 is 2.4:1). Areas are in MEGAPIXEL (1024²) units.
 *
 * No image may exceed 4 MP = 2048² — a product ceiling, not an engine one.
 *
 * Each group has two levels: `maxArea`, enforced on every parse, and
 * `recommendedArea`, past which the picker only warns.
 */

/**
 * Trained at ~1 MP, nothing larger documented: SDXL, Pony V6, Illustrious, NoobAI,
 * Chroma, HiDream-I1 — plus Flux.2 Klein and Z-Image Turbo until a test
 * generation confirms their family's larger figures apply to them. Illustrious
 * v1.0+ is 1536² native, but the ecosystem can't tell it from the v0.1 merges
 * that most checkpoints are, so the warning stays at 1 MP.
 */
export const sdxlCustomDimensionLimits = {
  step: 32,
  minSide: 512,
  maxSide: 2048,
  maxArea: 1536 * 1536,
  recommendedArea: MEGAPIXEL,
  maxRatio: 2.5,
} as const satisfies CustomDimensionLimits;

/**
 * Documented to ~2 MP: FLUX.1 dev / Krea ("0.1 to 2.0 megapixels"), Anima
 * (512²–1536²), Pony V7 (768–1536px, larger recommended), Boogu Base/Edit (up to
 * 2K). Same hard cap as the ~1 MP group; only the warning moves up.
 */
export const twoMegapixelCustomDimensionLimits = {
  ...sdxlCustomDimensionLimits,
  recommendedArea: 2 * MEGAPIXEL,
} as const satisfies CustomDimensionLimits;

/**
 * Documented to ~4 MP: FLUX.2 dev/pro/flex/max ("up to 4MP"), Ideogram 4 (256–2048
 * /16), Z-Image Base (512²–2048² total area). Capped at the 4 MP ceiling, which is
 * also what they recommend, so the picker never warns.
 */
export const fourMegapixelCustomDimensionLimits = {
  ...sdxlCustomDimensionLimits,
  maxArea: 4 * MEGAPIXEL,
  recommendedArea: 4 * MEGAPIXEL,
} as const satisfies CustomDimensionLimits;

/**
 * BFL's flux1-pro takes 256–1440 /32 per side, so 1440² (≈1.98 MP) is its most.
 * Same 2 MP recommendation as the rest of FLUX.1, so it never warns.
 */
export const flux1ProCustomDimensionLimits = {
  ...twoMegapixelCustomDimensionLimits,
  maxSide: 1440,
  maxArea: 1440 * 1440,
} as const satisfies CustomDimensionLimits;

/** SD1: ~512² training area; the comfy SD1 input caps each side at 1024. */
export const sd1CustomDimensionLimits = {
  step: 32,
  minSide: 256,
  maxSide: 1024,
  maxArea: 768 * 768,
  recommendedArea: 512 * 768,
  maxRatio: 2.5,
} as const satisfies CustomDimensionLimits;

/**
 * Every set of custom limits. A saved size belongs to the user, not to a model: it
 * is shown wherever it fits, so saving one only needs some model to accept it.
 */
export const allCustomDimensionLimits: readonly CustomDimensionLimits[] = [
  sdxlCustomDimensionLimits,
  twoMegapixelCustomDimensionLimits,
  fourMegapixelCustomDimensionLimits,
  flux1ProCustomDimensionLimits,
  sd1CustomDimensionLimits,
];

/** Shown before the picker's "More" button: the three buckets these pickers offered before. */
export const sdxlFullPriorityAspectRatios = ['3:2', '1:1', '2:3'];

/** SD1 training buckets (~512² area, /64 aligned). */
export const sd1AspectRatioBuckets = [
  { label: '2:3', value: '2:3', width: 512, height: 768 },
  { label: '1:1', value: '1:1', width: 512, height: 512 },
  { label: '3:2', value: '3:2', width: 768, height: 512 },
];

/**
 * Returns aspect ratio options (label/value/width/height) for the given
 * resolution tier, restricted to the requested ratios in their listed order.
 * Ratios that aren't defined for the resolution are skipped. Accepts a plain
 * string for `resolution` so callers don't need to narrow ctx values; unknown
 * resolutions yield an empty list.
 */
export function getAspectRatioOptions(resolution: string, ratios: GenerationAspectRatio[]) {
  const dims = aspectRatioDimensions[resolution as GenerationResolution] ?? {};
  return ratios.flatMap((ratio) => {
    const d = dims[ratio];
    return d ? [{ label: ratio, value: ratio, width: d.width, height: d.height }] : [];
  });
}

/** Standard Flux aspect ratios (1024px based) */
export const fluxAspectRatios = [
  { label: '2:3', width: 832, height: 1216 },
  { label: '1:1', width: 1024, height: 1024 },
  { label: '3:2', width: 1216, height: 832 },
  { label: '9:16', width: 768, height: 1344 },
  { label: '16:9', width: 1344, height: 768 },
];

/** Ultra mode aspect ratios (higher resolution) */
export const fluxUltraAspectRatios = [
  { label: '21:9', width: 3136, height: 1344 },
  { label: '16:9', width: 2752, height: 1536 },
  { label: '4:3', width: 2368, height: 1792 },
  { label: '1:1', width: 2048, height: 2048 },
  { label: '3:4', width: 1792, height: 2368 },
  { label: '9:16', width: 1536, height: 2752 },
  { label: '9:21', width: 1344, height: 3136 },
];
const defaultFluxUltraAspectRatioIndex = generation.defaultValues.fluxUltraAspectRatio;

export const fluxModelId = 618692;
export function getIsFluxUltra({ modelId, fluxMode }: { modelId?: number; fluxMode?: string }) {
  return modelId === fluxModelId && fluxMode === fluxUltraAir;
}

export function getIsFluxKrea({ modelId, fluxMode }: { modelId?: number; fluxMode?: string }) {
  return modelId === fluxModelId && fluxMode === fluxKreaAir;
}

export function getIsPonyV7(id: number) {
  return id === 2152373;
}

export function getSizeFromFluxUltraAspectRatio(value: number) {
  return fluxUltraAspectRatios[value] ?? fluxUltraAspectRatios[defaultFluxUltraAspectRatioIndex];
}

/** The label form `Flux1ProUltraImageGenInput.aspectRatio` takes, vs the index the sibling returns. */
export function getClosestFluxUltraAspectRatioLabel(width = 1024, height = 1024) {
  const ratios = fluxUltraAspectRatios.map((x) => x.width / x.height);
  const index = ratios.indexOf(findClosest(ratios, width / height));
  return (fluxUltraAspectRatios[index] ?? fluxUltraAspectRatios[defaultFluxUltraAspectRatioIndex])
    .label;
}

export function getClosestFluxUltraAspectRatio(width = 1024, height = 1024) {
  const ratios = fluxUltraAspectRatios.map((x) => x.width / x.height);
  const closest = findClosest(ratios, width / height);
  const index = ratios.indexOf(closest);
  return `${index ?? defaultFluxUltraAspectRatioIndex}`;
}

type GetUpscaleFactorProps = {
  width: number;
  height: number;
};
export function getUpscaleFactor(original: GetUpscaleFactorProps, upscale: GetUpscaleFactorProps) {
  const s1 = original.width > original.height ? original.width : original.height;
  const s2 = upscale.width > upscale.height ? upscale.width : upscale.height;
  return Math.round((s2 / s1) * 10) / 10;
}

export function getScaledWidthHeight(width: number, height: number, factor: number) {
  const originRatio = width / height;
  const wf = width * factor;
  const hf = height * factor;

  const wLimits = getUpperLowerLimits(wf);
  const hLimits = getUpperLowerLimits(hf);

  const options: { ratio: number; width: number; height: number }[] = [];

  for (const wl of wLimits) {
    for (const hl of hLimits) {
      options.push({ ratio: wl / hl, width: wl, height: hl });
    }
  }

  const closestRatio = findClosest(
    options.map(({ ratio }) => ratio),
    originRatio
  );
  const closest = options.find(({ ratio }) => ratio === closestRatio)!;
  return { width: closest.width, height: closest.height };
}

function getUpperLowerLimits(value: number) {
  // return [...new Set([Math.floor, Math.ceil].map((fn) => fn(value / 64) * 64))];
  return [
    ...new Set(
      [Math.floor, Math.ceil].flatMap((fn) => {
        const val = fn(value / 64) * 64;
        const arr = [val];
        const lower = val - 64;
        const upper = val + 64;
        if (lower >= minDownscaleSize) arr.push(lower);
        if (upper <= maxUpscaleSize) arr.push(upper);
        return arr;
      })
    ),
  ];
}

/** The generator's prompt cap. Here so the server's prompt comparison can bound its
 * input without importing the generation graph. */
export const MAX_PROMPT_LENGTH = 6000;
