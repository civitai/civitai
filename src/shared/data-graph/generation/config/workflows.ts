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

import { ECO, ecosystemByKey, ecosystemById } from '~/shared/constants/basemodel.constants';
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
  ECO.Seedream,
  ECO.NanoBanana,
  ECO.OpenAI,
  ECO.Flux2,
  ECO.Flux2Klein_9B,
  ECO.Flux2Klein_9B_base,
  ECO.Flux2Klein_4B,
  ECO.Flux2Klein_4B_base,
  ECO.Flux1Kontext,
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
  ECO.Chroma,
  ECO.Qwen,
  ECO.HiDream,
  ECO.NanoBanana,
  ECO.OpenAI,
  ECO.Imagen4,
  ECO.Seedream,
  ECO.PonyV7,
  ECO.ZImageTurbo,
  ECO.ZImageBase,
];

/** Video ecosystems that support video:create */
const TXT2VID_IDS = [
  ECO.HyV1,
  ECO.LTXV2,
  ECO.WanVideo,
  ECO.WanVideo14B_T2V,
  ECO.WanVideo22_TI2V_5B,
  ECO.WanVideo22_T2V_A14B,
  ECO.WanVideo25_T2V,
  ECO.Veo3,
  ECO.Sora2,
  ECO.Mochi,
  ECO.Vidu,
  ECO.MiniMax,
  ECO.Kling,
  ECO.Haiper,
  ECO.Lightricks,
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
  ECO.WanVideo,
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
    label: 'Image to Image',
    description: 'Generate an image from an existing image',
    category: 'image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  'img2img:edit': {
    label: 'Edit Image',
    description: 'Edit an image with AI',
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
    ecosystemIds: [],
  },

  'img2img:remove-background': {
    label: 'Remove Background',
    description: 'Remove the background from an image',
    category: 'image',
    enhancement: true,
    ecosystemIds: [],
    memberOnly: true,
  },

  // ===========================================================================
  // Video Workflows
  // ===========================================================================

  txt2vid: {
    label: 'Create Video',
    modeLabel: 'Text to Video',
    description: 'Generate an AI video from text',
    category: 'video',
    ecosystemIds: TXT2VID_IDS,
  },

  img2vid: {
    label: 'Image to Video',
    description: 'Generate a video from an image',
    category: 'video',
    ecosystemIds: [...TXT2VID_IDS, ...I2V_ONLY_IDS],
    aliases: [
      {
        label: 'First/Last Frame',
        description: 'Create video from start and end images',
        ecosystemIds: [ECO.Vidu],
      },
    ],
  },

  'img2vid:ref2vid': {
    label: 'Reference to Video',
    description: 'Generate video using a reference image',
    category: 'video',
    ecosystemIds: [ECO.Vidu, ECO.Veo3],
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
 */
export function getWorkflowsForEcosystem(ecosystemId: number): WorkflowOption[] {
  return workflowOptions.filter((w) => {
    if (w.ecosystemIds.length === 0) return true; // Standalone (available to all)
    return w.ecosystemIds.includes(ecosystemId);
  });
}

/** Workflow categories with labels */
export const workflowCategories: { category: WorkflowCategory; label: string }[] = [
  { category: 'image', label: 'Image' },
  { category: 'video', label: 'Video' },
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
      .filter((w) => w.category === category)
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
      .filter((w) => w.category === category)
      .map((w) => ({ ...w, compatible: true })),
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
export function getOutputTypeForWorkflow(workflowId: string): 'image' | 'video' {
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
 * Get the display label for a workflow on a specific ecosystem (alias-aware).
 * Returns the alias label when the ecosystem matches an alias entry,
 * otherwise returns the primary config label.
 */
export function getWorkflowLabelForEcosystem(graphKey: string, ecosystemId?: number): string {
  if (ecosystemId !== undefined) {
    const match = workflowOptions.find(
      (o) => o.graphKey === graphKey && o.ecosystemIds.includes(ecosystemId)
    );
    if (match) return match.label;
  }
  return workflowConfigByKey.get(graphKey)?.label ?? graphKey;
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
];

/**
 * Get workflow mode options for the segmented control.
 * Finds the group containing this workflow, checks for ecosystem-specific overrides,
 * then filters to ecosystem-compatible entries.
 * Returns empty array if < 2 compatible modes (no selector needed).
 */
export function getWorkflowModes(
  workflowId: string,
  ecosystemKey: string
): { label: string; value: string }[] {
  const group = workflowGroups.find((g) => g.workflows.includes(workflowId));
  if (!group) return [];

  const ecosystem = ecosystemByKey.get(ecosystemKey);
  if (!ecosystem) return [];

  // Check for ecosystem-specific override first
  const override = group.overrides?.find((o) => o.ecosystemIds.includes(ecosystem.id));
  const availableWorkflows = override
    ? override.workflows
    : group.workflows.filter((wfId) => isWorkflowAvailable(wfId, ecosystem.id));

  const modes = availableWorkflows.map((wfId) => {
    const config = workflowConfigByKey.get(wfId);
    return { label: config?.modeLabel ?? config?.label ?? wfId, value: wfId };
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
