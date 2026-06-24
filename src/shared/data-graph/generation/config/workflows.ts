/**
 * Workflow Configurations
 *
 * Unified workflow definitions with metadata and node configurations.
 * Workflow keys follow the format: {input}2{output}:{variant}
 *
 * Examples:
 *   txt2img           - text to image creation
 *   img2img           - image to image (SD family)
 *   img2img:edit      - image editing (Qwen, Flux Kontext, etc.)
 *   txt2vid           - text to video
 *   img2vid           - image to video
 */

import {
  ECO,
  ecosystemByKey,
  ecosystemById,
  getEcosystemSupport,
} from '~/shared/constants/basemodel.constants';
import type { OutputType } from './types';
// Import version-id constants from the leaf module, NOT the *-graph files. The
// graphs import helpers from this file, so importing them back here would form a
// graph <-> config/workflows cycle (the cause of "X is undefined" at module-eval).
import {
  happyHorseVersionIds,
  klingVersionIds,
  nanoBananaVersionIds,
  viduVersionIds,
} from '~/shared/data-graph/generation/version-ids';
import {
  type WorkflowCategory,
  type WorkflowConfig,
  type WorkflowConfigs,
  type WorkflowGroup,
} from './types';

// Re-export types for convenience
export type { WorkflowCategory };

// =============================================================================
// Ecosystem ID Groups
// =============================================================================

/** SD family ecosystem IDs */
const SD_FAMILY_IDS = [ECO.SD1, ECO.SDXL, ECO.Pony, ECO.Illustrious, ECO.NoobAI];

/** Ecosystem IDs that support draft mode (SD family + Flux1) */
const DRAFT_IDS = [...SD_FAMILY_IDS, ECO.Flux1];

/** Image ecosystems that support image:edit (accept optional/required images for editing) */
const EDIT_IMG_IDS = [
  ECO.Qwen,
  ECO.Qwen2,
  ECO.Seedream,
  ECO.NanoBanana,
  ECO.OpenAI,
  ECO.Flux2,
  ECO.Flux2Klein_9B,
  ECO.Flux2Klein_9B_base,
  ECO.Flux2Klein_4B,
  ECO.Flux2Klein_4B_base,
  ECO.Flux1Kontext,
  ECO.Grok,
  ECO.WanImage27,
  ECO.HiDreamO1,
  ECO.MAI,
  ECO.Boogu,
];

/** Image ecosystems that support image:create */
const TXT2IMG_IDS = [
  // SD family
  ECO.SD1,
  ECO.SDXL,
  ECO.Pony,
  ECO.Illustrious,
  ECO.NoobAI,
  // Flux family
  ECO.Flux1,
  ECO.FluxKrea,
  ECO.Flux1Kontext,
  ECO.Flux2,
  ECO.Flux2Klein_9B,
  ECO.Flux2Klein_9B_base,
  ECO.Flux2Klein_4B,
  ECO.Flux2Klein_4B_base,
  // Other image ecosystems
  ECO.Anima,
  ECO.Chroma,
  ECO.Qwen,
  ECO.Qwen2,
  ECO.HiDream,
  ECO.HiDreamO1,
  ECO.NanoBanana,
  ECO.OpenAI,
  ECO.Imagen4,
  ECO.Seedream,
  ECO.PonyV7,
  ECO.ZImageTurbo,
  ECO.ZImageBase,
  ECO.Grok,
  ECO.WanImage27,
  ECO.Ernie,
  ECO.Lens,
  ECO.Krea2,
  ECO.MAI,
  ECO.Boogu,
];

/** Video ecosystems that support video:create */
const TXT2VID_IDS = [
  ECO.HyV1,
  ECO.LTXV2,
  ECO.LTXV23,
  ECO.WanVideo14B_T2V,
  ECO.WanVideo22_TI2V_5B,
  ECO.WanVideo22_T2V_A14B,
  ECO.WanVideo25_T2V,
  ECO.WanVideo27,
  ECO.Veo3,
  ECO.Sora2,
  ECO.Vidu,
  // ECO.MiniMax,
  ECO.Kling,
  // ECO.Haiper,
  // ECO.Lightricks,
  ECO.Grok,
  ECO.Seedance,
  ECO.HappyHorse,
];

/** I2V-only Wan ecosystems (no T2V support) — added to video:create with required images */
const I2V_ONLY_IDS = [
  ECO.WanVideo14B_I2V_480p,
  ECO.WanVideo14B_I2V_720p,
  ECO.WanVideo22_I2V_A14B,
  ECO.WanVideo25_I2V,
];

/** All Wan ecosystem IDs (T2V + I2V) — used for workflow group overrides */
const WAN_ALL_IDS = [
  ECO.WanVideo14B_T2V,
  ECO.WanVideo22_TI2V_5B,
  ECO.WanVideo22_T2V_A14B,
  ECO.WanVideo25_T2V,
  ...I2V_ONLY_IDS,
];

// =============================================================================
// Workflow Configs
// =============================================================================

export const workflowConfigs: WorkflowConfigs = {
  // ===========================================================================
  // Image Creation Workflows
  // ===========================================================================

  txt2img: {
    label: 'Create Image',
    modeLabel: 'Text to Image',
    description: 'Generate an AI image from text',
    category: 'image',
    ecosystemIds: TXT2IMG_IDS,
  },

  'txt2img:draft': {
    label: 'Draft',
    description: 'Fast generation for quick iterations',
    category: 'image',
    ecosystemIds: DRAFT_IDS,
  },

  'txt2img:face-fix': {
    label: 'Create + Face Fix',
    modeLabel: 'Text to Image',
    description: 'Generate with automatic face correction',
    category: 'image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  'txt2img:hires-fix': {
    label: 'Create + Hires Fix',
    modeLabel: 'Text to Image',
    description: 'Generate with upscaling for higher detail',
    category: 'image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  img2img: {
    label: 'Image Variations',
    description: 'Generate a variation of an existing image',
    category: 'image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  'img2img:edit': {
    label: 'Image to Image',
    description: 'Generate or edit using reference images',
    category: 'image',
    ecosystemIds: EDIT_IMG_IDS,
  },

  'img2img:face-fix': {
    label: 'Image Face Fix',
    modeLabel: 'Image to Image',
    description: 'Fix faces in an existing image',
    category: 'image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  'img2img:hires-fix': {
    label: 'Image Hires Fix',
    modeLabel: 'Image to Image',
    description: 'Hires fix from an existing image',
    category: 'image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  // ===========================================================================
  // Image Enhancement Workflows (Standalone)
  // ===========================================================================

  'img2img:upscale': {
    label: 'Upscale',
    description: 'Increase image resolution',
    category: 'image',
    enhancement: true,
    returnAfterSubmit: true,
    showBackButton: true,
    ecosystemIds: [ECO.Upscaler],
  },

  'img2img:remove-background': {
    label: 'Remove Background',
    description: 'Remove the background from an image',
    category: 'image',
    enhancement: true,
    returnAfterSubmit: true,
    showBackButton: true,
    ecosystemIds: [],
    memberOnly: true,
  },

  'img2img:preprocess': {
    label: 'Control Preprocessor',
    description: 'Run a ControlNet preprocessor on an image (canny, openpose, depth, etc.)',
    category: 'image',
    showBackButton: true,
    // ControlNets are disabled for now, so the preprocessor — which only produces
    // input for a ControlNet — is hidden from the picker too.
    hidden: true,
    ecosystemIds: [],
    isNew: true,
  },

  // ===========================================================================
  // Image Utility Workflows (Standalone, no generation)
  // ===========================================================================

  img2meta: {
    label: 'Extract Metadata',
    description: 'Extract generation parameters from an image',
    category: 'image',
    ecosystemIds: [],
    noSubmit: true,
  },

  // ===========================================================================
  // Video Workflows
  // ===========================================================================

  txt2vid: {
    label: 'Create Video',
    modeLabel: 'Text to Video',
    description: 'Generate video from text',
    category: 'video',
    ecosystemIds: TXT2VID_IDS,
  },

  img2vid: {
    label: 'Image to Video',
    description: 'Generate video from an image',
    category: 'video',
    ecosystemIds: [...TXT2VID_IDS, ...I2V_ONLY_IDS],
  },

  'img2vid:first-last': {
    label: 'First/Last Frame',
    description: 'Generate video from start and end images',
    category: 'video',
    ecosystemIds: [ECO.Vidu, ECO.Kling, ECO.LTXV2, ECO.LTXV23, ECO.WanVideo27],
    excludeModelVersionIds: [klingVersionIds.v1_6, klingVersionIds.v2, klingVersionIds.v2_5_turbo],
    variantOf: 'img2vid',
  },

  'img2vid:ref2vid': {
    label: 'Reference to Video',
    description: 'Generate video using a reference image',
    category: 'video',
    ecosystemIds: [ECO.Vidu, ECO.Veo3, ECO.Kling, ECO.LTXV23, ECO.WanVideo27, ECO.HappyHorse],
    excludeModelVersionIds: [viduVersionIds.q3],
  },

  // ===========================================================================
  // Video Enhancement Workflows
  // ===========================================================================

  'vid2vid:upscale': {
    label: 'Upscale',
    description: 'Increase video resolution',
    category: 'video',
    enhancement: true,
    ecosystemIds: [],
  },

  'vid2vid:interpolate': {
    label: 'Interpolate',
    description: 'Smooth video by adding frames',
    category: 'video',
    enhancement: true,
    ecosystemIds: [],
  },

  'vid2vid:edit': {
    label: 'Edit Video',
    description: 'Edit a video with AI',
    category: 'video',
    ecosystemIds: [ECO.Grok, ECO.WanVideo27, ECO.HappyHorse],
    // HappyHorse v1.1 has no videoEdit operation — v1.0 only.
    excludeModelVersionIds: [happyHorseVersionIds['v1.1']],
  },

  // Disabled — LTXV23 extendVideo is producing poor results. Re-enable once
  // generation quality improves. Graph branches and handler case are left in
  // place so re-enabling is just uncommenting this entry.
  // 'vid2vid:extend': {
  //   label: 'Extend Video',
  //   description: 'Extend a video with new content',
  //   category: 'video',
  //   ecosystemIds: [ECO.LTXV23],
  // },

  // ===========================================================================
  // Audio Workflows
  // ===========================================================================

  txt2music: {
    label: 'Create Music',
    modeLabel: 'Text to Music',
    description: 'Generate music from text description and lyrics',
    category: 'audio',
    ecosystemIds: [ECO.AceAudio],
    stepDisplay: 'separate',
    memberOnly: true,
  },

  // ===========================================================================
  // 3D Model Workflows (PolyGen / Meshy via Fal)
  // ===========================================================================
  //
  // Both workflows ride the unified V2 pipeline (graph → handler → submit).
  // Field rendering lives in `GenerationForm.tsx`, gated on the PolyGen
  // ecosystem; submission/whatif go through `generateFromGraph` /
  // `whatIfFromGraph` like every other ecosystem. Feature-flagged behind
  // `model3dGenerator`.

  txt2model3d: {
    label: 'Create 3D Model',
    modeLabel: 'Text to 3D',
    description: 'Generate a 3D model from a text prompt (PolyGen via Meshy)',
    category: 'model3d',
    ecosystemIds: [ECO.PolyGen],
    featureFlag: 'model3dGenerator',
    isNew: true,
  },

  img2model3d: {
    // Shares the `txt2model3d` label so the in-form title row reads the
    // same "Create 3D Model" regardless of the selected mode (mirrors the
    // Image segment, where txt2img/img2img both title as "Create Image").
    label: 'Create 3D Model',
    modeLabel: 'Image to 3D',
    description: 'Generate a 3D model from a source image (PolyGen via Meshy)',
    category: 'model3d',
    ecosystemIds: [ECO.PolyGen],
    featureFlag: 'model3dGenerator',
    isNew: true,
  },

  // ===========================================================================
  // Text Output Workflows (hidden from picker, triggered programmatically)
  // ===========================================================================

  'prompt:enhance': {
    label: 'Enhance Prompt',
    description: 'Improve your prompt with AI suggestions',
    category: 'image',
    ecosystemIds: [],
    noSubmit: true,
    hidden: true,
    enhancement: true,
  },
};

// =============================================================================
// Bulk Workflow Limits
// =============================================================================

/** Workflows that support bulk image actions and their max image count */
export const bulkWorkflowLimits: Record<string, number> = {
  'img2img:upscale': 10,
};

// =============================================================================
// Workflow Lookup Utilities
// =============================================================================

/** Array of all workflow configs for iteration */
export const workflowConfigsArray = Object.entries(workflowConfigs)
  .filter((entry): entry is [string, WorkflowConfig] => entry[1] !== undefined)
  .map(([key, config]) => ({
    key,
    ...config,
  }));

/** Lookup map for workflows by key (aggregates alias ecosystemIds into parent) */
export const workflowConfigByKey = new Map(
  workflowConfigsArray.map((w) => {
    if (!w.aliases?.length) return [w.key, w];
    const allEcoIds = [...w.ecosystemIds, ...w.aliases.flatMap((a) => a.ecosystemIds)];
    return [w.key, { ...w, ecosystemIds: [...new Set(allEcoIds)] }];
  })
);

// =============================================================================
// Workflow Option Type (for UI consumption)
// =============================================================================

export type WorkflowOption = {
  /** Unique ID for this option (key for primary, key#alias-index for aliases) */
  id: string;
  /** The graph discriminator value (always matches a real config key) */
  graphKey: string;
  /** Display label */
  label: string;
  /** Brief description of what this workflow does */
  description?: string;
  /** Per-entry ecosystem IDs (NOT aggregated) */
  ecosystemIds: number[];
  /** Category for grouping in UI */
  category: WorkflowCategory;
  /** Input type required */
  inputType: 'text' | 'image' | 'video';
  /** If true, this workflow is ecosystem-specific */
  ecosystemSpecific?: boolean;
  /** Whether this is an enhancement workflow */
  enhancement?: boolean;
  /** If true, this workflow requires membership */
  memberOnly?: boolean;
  /** Model version IDs that should NOT see this option */
  excludeModelVersionIds?: number[];
  /** If true, render a "New" badge next to the label in the workflow picker */
  isNew?: boolean;
};

/**
 * All workflow options derived from workflow configs.
 * Aliases are expanded into separate entries with unique IDs (key#index).
 */
export const workflowOptions: WorkflowOption[] = workflowConfigsArray.flatMap((w) => {
  const primary: WorkflowOption = {
    id: w.key,
    graphKey: w.key,
    label: w.label,
    description: w.description,
    ecosystemIds: w.ecosystemIds,
    category: w.category,
    inputType: getInputTypeForWorkflow(w.key),
    ecosystemSpecific: w.ecosystemIds.length === 1,
    enhancement: w.enhancement,
    memberOnly: w.memberOnly,
    excludeModelVersionIds: w.excludeModelVersionIds,
    isNew: w.isNew,
  };

  const aliases: WorkflowOption[] = (w.aliases ?? []).map((alias, i) => ({
    id: `${w.key}#${i}`,
    graphKey: w.key,
    label: alias.label,
    description: alias.description,
    ecosystemIds: alias.ecosystemIds,
    category: w.category,
    inputType: getInputTypeForWorkflow(w.key),
    ecosystemSpecific: alias.ecosystemIds.length === 1,
    enhancement: w.enhancement,
    memberOnly: w.memberOnly,
    excludeModelVersionIds: alias.excludeModelVersionIds,
    isNew: w.isNew,
  }));

  return [primary, ...aliases];
});

/** Lookup map for workflows by ID (workflow key) */
export const workflowOptionById = new Map(workflowOptions.map((w) => [w.id, w]));

// =============================================================================
// Workflow Helper Functions
// =============================================================================

/**
 * Check if a workflow is available for an ecosystem.
 */
/** Check if a workflow key is a specific workflow or a variant of it */
export function isWorkflowOrVariant(workflow: string, base: string): boolean {
  if (workflow === base) return true;
  return workflowConfigByKey.get(workflow)?.variantOf === base;
}

export function isWorkflowAvailable(workflowId: string, ecosystemId: number): boolean {
  const config = workflowConfigByKey.get(workflowId);
  if (!config) return false;
  // Workflows with empty ecosystemIds are standalone (available to all)
  if (config.ecosystemIds.length === 0) return true;
  return config.ecosystemIds.includes(ecosystemId);
}

/**
 * Get workflows available for a specific ecosystem.
 * Uses per-entry ecosystemIds (not aggregated) so aliases filter correctly.
 * Optionally filters out options excluded for a specific model version.
 */
export function getWorkflowsForEcosystem(
  ecosystemId: number,
  modelVersionId?: number
): WorkflowOption[] {
  return workflowOptions.filter((w) => {
    if (workflowConfigByKey.get(w.graphKey)?.hidden) return false;
    if (w.ecosystemIds.length === 0) return true; // Standalone (available to all)
    if (!w.ecosystemIds.includes(ecosystemId)) return false;
    if (modelVersionId && w.excludeModelVersionIds?.includes(modelVersionId)) return false;
    return true;
  });
}

/** Workflow categories with labels */
export const workflowCategories: { category: WorkflowCategory; label: string }[] = [
  { category: 'image', label: 'Image' },
  { category: 'video', label: 'Video' },
  { category: 'audio', label: 'Audio' },
  { category: 'model3d', label: '3D Models' },
];

/**
 * Get all workflows grouped by category with compatibility info for an ecosystem.
 */
export function getWorkflowsWithCompatibility(ecosystemId: number): {
  category: WorkflowCategory;
  label: string;
  workflows: (WorkflowOption & { compatible: boolean })[];
}[] {
  return workflowCategories.map(({ category, label }) => ({
    category,
    label,
    workflows: workflowOptions
      .filter((w) => w.category === category && !workflowConfigByKey.get(w.graphKey)?.hidden)
      .map((w) => ({
        ...w,
        compatible: w.ecosystemIds.length === 0 || w.ecosystemIds.includes(ecosystemId),
      })),
  }));
}

/**
 * Get all workflows grouped by category (without compatibility info).
 */
export function getAllWorkflowsGrouped(): {
  category: WorkflowCategory;
  label: string;
  workflows: (WorkflowOption & { compatible: boolean })[];
}[] {
  return workflowCategories.map(({ category, label }) => ({
    category,
    label,
    workflows: workflowOptions
      .filter((w) => w.category === category && !workflowConfigByKey.get(w.graphKey)?.hidden)
      .map((w) => ({ ...w, compatible: true })),
  }));
}

/**
 * Drop workflow options whose backing ecosystems are all in `gatedEcosystemKeys`.
 * Standalone workflows (no ecosystem) are always kept; a workflow with at least
 * one ungated ecosystem is kept too.
 *
 * Used by `WorkflowInput` so e.g. the Audio segment disappears when the
 * AceAudio ecosystem is mod-only and the current user is not a moderator.
 */
export function filterWorkflowsByGatedEcosystems<T extends { workflows: WorkflowOption[] }>(
  grouped: T[],
  gatedEcosystemKeys: ReadonlySet<string>
): T[] {
  if (gatedEcosystemKeys.size === 0) return grouped;
  return grouped.map((group) => ({
    ...group,
    workflows: group.workflows.filter((w) => {
      if (w.ecosystemIds.length === 0) return true;
      return w.ecosystemIds.some((id) => {
        const key = ecosystemById.get(id)?.key;
        return !key || !gatedEcosystemKeys.has(key);
      });
    }),
  }));
}

/**
 * Returns the feature-flag name a workflow requires, or `undefined` when
 * the workflow is universally available. Server-side request handlers
 * (e.g. orchestrator `generateFromGraph` / `whatIfFromGraph`) MUST consult
 * this and reject submissions that lack the flag — `filterWorkflowsByFeatureFlags`
 * only hides the option in the picker UI, so a crafted request payload would
 * otherwise bypass the gate.
 */
export function getRequiredFeatureFlagForWorkflow(
  workflowId: string | undefined
): string | undefined {
  if (!workflowId) return undefined;
  return workflowConfigByKey.get(workflowId)?.featureFlag;
}

/**
 * Drop workflow options whose `featureFlag` is set to a flag that's disabled
 * for this user. Workflows without a `featureFlag` are always kept.
 *
 * Used by `WorkflowInput` to hide flag-gated workflows from the picker.
 */
export function filterWorkflowsByFeatureFlags<T extends { workflows: WorkflowOption[] }>(
  grouped: T[],
  features: Record<string, boolean | undefined>
): T[] {
  return grouped.map((group) => ({
    ...group,
    workflows: group.workflows.filter((w) => {
      const flag = workflowConfigByKey.get(w.graphKey)?.featureFlag;
      if (!flag) return true;
      return features[flag] === true;
    }),
  }));
}

/**
 * Get the first compatible ecosystem for a workflow.
 */
export function getDefaultEcosystemForWorkflow(workflowId: string): number | undefined {
  const config = workflowConfigByKey.get(workflowId);
  if (!config) return undefined;

  // Return the first ecosystem from the config, or undefined for standalone workflows
  return config.ecosystemIds[0];
}

/**
 * Get all ecosystem IDs that support a specific workflow.
 */
export function getEcosystemsForWorkflow(workflowId: string): number[] {
  const config = workflowConfigByKey.get(workflowId);
  return config?.ecosystemIds ?? [];
}

/**
 * Get the input type for a workflow, derived from the key prefix.
 * Workflow keys follow {input}2{output}:{variant} — e.g. txt2img, img2vid:ref2vid, vid2vid:upscale.
 */
export function getInputTypeForWorkflow(workflowId: string): 'text' | 'image' | 'video' {
  if (workflowId.startsWith('img2')) return 'image';
  if (workflowId.startsWith('vid2')) return 'video';
  return 'text';
}

/**
 * Get the output type from a workflow key.
 */
export function getOutputTypeForWorkflow(workflowId: string): OutputType {
  const config = workflowConfigByKey.get(workflowId);
  return config?.category ?? 'image';
}

/**
 * Check if a workflow is an enhancement workflow (e.g. upscale, remove-background).
 */
export function isEnhancementWorkflow(workflowId: string): boolean {
  return workflowConfigByKey.get(workflowId)?.enhancement === true;
}

/**
 * Whether the form should auto-navigate back to the previous workflow and
 * clear the source media after a successful submit. See
 * `WorkflowConfig.returnAfterSubmit` for the rationale.
 */
export function shouldReturnAfterSubmit(workflowId: string): boolean {
  return workflowConfigByKey.get(workflowId)?.returnAfterSubmit === true;
}

/**
 * Whether the workflow header should render a back-button.
 * See `WorkflowConfig.showBackButton` for the rationale.
 */
export function shouldShowBackButton(workflowId: string): boolean {
  return workflowConfigByKey.get(workflowId)?.showBackButton === true;
}

/**
 * Get the display label for a workflow on a specific ecosystem (alias-aware).
 * Returns the alias label when the ecosystem matches an alias entry,
 * otherwise returns the primary config label.
 * Skips aliases excluded for the given model version.
 */
export function getWorkflowLabelForEcosystem(
  graphKey: string,
  ecosystemId?: number,
  modelVersionId?: number
): string {
  if (ecosystemId !== undefined) {
    const match = workflowOptions.find(
      (o) =>
        o.graphKey === graphKey &&
        o.ecosystemIds.includes(ecosystemId) &&
        !(modelVersionId && o.excludeModelVersionIds?.includes(modelVersionId))
    );
    if (match) return match.label;
  }
  return workflowConfigByKey.get(graphKey)?.label ?? graphKey;
}

// =============================================================================
// Legacy Form Support
// =============================================================================

/**
 * Rules for workflow/ecosystem/model combinations ONLY available in the new generation form.
 * The legacy form does not support these combinations.
 *
 * Entry types:
 * - `true` — the entire workflow has no legacy equivalent
 * - `(ecosystemId, modelId?) => boolean` — predicate for fine-grained checks
 *   (e.g. a specific model version within an ecosystem)
 *
 * When adding new workflows or ecosystem/model support only to the new form, add them here.
 */
type NewFormOnlyRule = true | ((ecosystemId: number, modelId?: number) => boolean);

const NEW_FORM_ONLY = new Map<string, NewFormOnlyRule>([
  // Upscale workflow — legacy form has no upscaler node
  ['img2img:upscale', true],

  // Preprocess workflow — new form only (no legacy equivalent)
  ['img2img:preprocess', true],

  // Kling V3 and Vidu Q3 on standard video workflows (legacy doesn't support these versions)
  [
    'txt2vid',
    (ecoId, modelId) =>
      (ecoId === ECO.Kling && modelId === klingVersionIds.v3) ||
      (ecoId === ECO.Vidu && modelId === viduVersionIds.q3) ||
      ecoId === ECO.Grok ||
      ecoId === ECO.WanVideo27 ||
      ecoId === ECO.Seedance ||
      ecoId === ECO.HappyHorse,
  ],
  [
    'img2vid',
    (ecoId, modelId) =>
      (ecoId === ECO.Kling && modelId === klingVersionIds.v3) ||
      (ecoId === ECO.Vidu && modelId === viduVersionIds.q3) ||
      ecoId === ECO.Grok ||
      ecoId === ECO.WanVideo27 ||
      ecoId === ECO.Seedance ||
      ecoId === ECO.HappyHorse,
  ],

  // ref2vid: legacy forms for Kling, Veo3, and Vidu don't support this workflow
  [
    'img2vid:ref2vid',
    (ecoId) =>
      ecoId === ECO.Kling ||
      ecoId === ECO.Veo3 ||
      ecoId === ECO.Vidu ||
      ecoId === ECO.WanVideo27 ||
      ecoId === ECO.HappyHorse,
  ],

  // NanoBanana V2 - only available in new form
  [
    'txt2img',
    (ecoId, modelId) =>
      (ecoId === ECO.NanoBanana && modelId === nanoBananaVersionIds.v2) ||
      ecoId === ECO.Anima ||
      ecoId === ECO.Grok ||
      ecoId === ECO.Qwen2 ||
      ecoId === ECO.WanImage27 ||
      ecoId === ECO.Ernie ||
      ecoId === ECO.HiDreamO1 ||
      ecoId === ECO.Lens ||
      ecoId === ECO.Krea2 ||
      ecoId === ECO.MAI ||
      ecoId === ECO.Boogu,
  ],
  [
    'img2img:edit',
    (ecoId, modelId) =>
      (ecoId === ECO.NanoBanana && modelId === nanoBananaVersionIds.v2) ||
      ecoId === ECO.Grok ||
      ecoId === ECO.Qwen2 ||
      ecoId === ECO.WanImage27 ||
      ecoId === ECO.HiDreamO1 ||
      ecoId === ECO.Boogu,
  ],

  // Grok/LTXV23 vid2vid:edit - no legacy equivalent
  ['vid2vid:edit', true],

  // vid2vid:extend - no legacy equivalent
  ['vid2vid:extend', true],

  // Audio workflows - no legacy equivalent
  ['txt2music', true],

  // 3D Model workflows - no legacy equivalent
  ['txt2model3d', true],
  ['img2model3d', true],
]);

/**
 * Check if a workflow+ecosystem+model combination is only available in the new generation form.
 * Returns true if the legacy form does NOT support this combination.
 */
export function isNewFormOnly(
  workflowKey: string,
  ecosystemId?: number,
  modelId?: number
): boolean {
  const entry = NEW_FORM_ONLY.get(workflowKey);
  if (entry === undefined) return false;
  if (entry === true) return true;
  if (ecosystemId === undefined) return false;
  return entry(ecosystemId, modelId);
}

// =============================================================================
// Workflow Groups (Mode Switching)
// =============================================================================

/**
 * Workflow groups — workflows that can be toggled between via a segmented control.
 * The UI filters each group to only show workflows supported by the current ecosystem.
 * Overrides allow specific ecosystems to show a different subset of workflows.
 */
export const workflowGroups: WorkflowGroup[] = [
  { workflows: ['txt2img', 'img2img', 'img2img:edit'] },
  { workflows: ['txt2img:face-fix', 'img2img:face-fix'] },
  { workflows: ['txt2img:hires-fix', 'img2img:hires-fix'] },
  {
    workflows: ['txt2vid', 'img2vid', 'img2vid:ref2vid'],
    overrides: [{ ecosystemIds: WAN_ALL_IDS, workflows: ['txt2vid', 'img2vid'] }],
  },
  { workflows: ['vid2vid:edit', 'vid2vid:extend'] },
  // 3D Models — mirrors the Image segment's "Text to / Image to" toggle.
  { workflows: ['txt2model3d', 'img2model3d'] },
];

/**
 * Get workflow mode options for the segmented control.
 * Finds the group containing this workflow, checks for ecosystem-specific overrides,
 * then filters to ecosystem-compatible entries.
 * Returns empty array if < 2 compatible modes (no selector needed).
 */
export function getWorkflowModes(
  workflowId: string,
  ecosystemKey: string,
  modelVersionId?: number
): { label: string; value: string; description?: string }[] {
  const resolvedId = workflowConfigByKey.get(workflowId)?.variantOf ?? workflowId;
  const group = workflowGroups.find((g) => g.workflows.includes(resolvedId));
  if (!group) return [];

  const ecosystem = ecosystemByKey.get(ecosystemKey);
  if (!ecosystem) return [];

  // Check for ecosystem-specific override first
  const override = group.overrides?.find((o) => o.ecosystemIds.includes(ecosystem.id));
  const availableWorkflows = (
    override
      ? override.workflows
      : group.workflows.filter((wfId) => isWorkflowAvailable(wfId, ecosystem.id))
  ).filter((wfId) => {
    // Filter out workflows excluded for this model version
    if (!modelVersionId) return true;
    const config = workflowConfigByKey.get(wfId);
    return !config?.excludeModelVersionIds?.includes(modelVersionId);
  });

  const modes = availableWorkflows.map((wfId) => {
    const config = workflowConfigByKey.get(wfId);
    return {
      label: config?.modeLabel ?? config?.label ?? wfId,
      value: wfId,
      description: config?.description,
    };
  });

  return modes.length > 1 ? modes : [];
}

/**
 * Get the valid ecosystem for a workflow, considering the current value.
 * If the current ecosystem supports the workflow, returns it.
 * Otherwise returns the default ecosystem for that workflow.
 */
export function getValidEcosystemForWorkflow(
  workflowId: string,
  currentEcosystemKey?: string
): { id: number; key: string; displayName: string } | undefined {
  // If current value supports the workflow, use it
  if (currentEcosystemKey) {
    const ecosystem = ecosystemByKey.get(currentEcosystemKey);
    if (ecosystem && isWorkflowAvailable(workflowId, ecosystem.id)) {
      return { id: ecosystem.id, key: ecosystem.key, displayName: ecosystem.displayName };
    }
  }
  // Otherwise get the default
  const defaultEcoId = getDefaultEcosystemForWorkflow(workflowId);
  if (defaultEcoId) {
    const eco = ecosystemById.get(defaultEcoId);
    if (eco) {
      return { id: eco.id, key: eco.key, displayName: eco.displayName };
    }
  }
  return undefined;
}

// =============================================================================
// Workflow ↔ Generation Support Validation
// =============================================================================

/**
 * Dev-time validation: logs ecosystem IDs referenced in workflow configs that
 * lack generation support in basemodel.constants, and vice versa.
 */
if (process.env.NODE_ENV === 'development') {
  // Collect all non-standalone ecosystem IDs from workflow configs
  const workflowEcoIds = new Set<number>();
  for (const w of workflowConfigsArray) {
    for (const id of w.ecosystemIds) workflowEcoIds.add(id);
    if (w.aliases) {
      for (const alias of w.aliases) {
        for (const id of alias.ecosystemIds) workflowEcoIds.add(id);
      }
    }
  }

  // Check: in workflow configs but missing generation support
  const missingSupport: string[] = [];
  for (const id of workflowEcoIds) {
    const eco = ecosystemById.get(id);
    if (!eco) {
      missingSupport.push(`ID ${id} (not found in ecosystems)`);
      continue;
    }
    if (!getEcosystemSupport(eco.id, 'generation')) {
      missingSupport.push(`${eco.key} (ID ${id})`);
    }
  }

  // Check: has generation support but not in any workflow config
  const missingWorkflow: string[] = [];
  for (const [id, eco] of ecosystemById) {
    if (!getEcosystemSupport(id, 'generation')) continue;
    if (!workflowEcoIds.has(id)) {
      missingWorkflow.push(`${eco.key} (ID ${id})`);
    }
  }

  if (missingSupport.length) {
    console.warn(
      `[workflow-validation] Ecosystems in workflow configs WITHOUT generation support:\n` +
        missingSupport.map((s) => `  - ${s}`).join('\n')
    );
  }
  if (missingWorkflow.length) {
    console.warn(
      `[workflow-validation] Ecosystems with generation support NOT in any workflow config:\n` +
        missingWorkflow.map((s) => `  - ${s}`).join('\n')
    );
  }
}
