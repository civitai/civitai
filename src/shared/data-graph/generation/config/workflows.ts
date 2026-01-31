/**
 * Workflow Configurations
 *
 * Unified workflow definitions with metadata and node configurations.
 * Workflow keys follow the format: {input}2{output} or {input}2{output}:{variant}
 *
 * Examples:
 *   txt2img        → input: text, output: image
 *   img2img:edit   → input: image, output: image, variant: edit
 *   img2vid:animate → input: image, output: video, variant: animate
 *
 * Node configs support layered overrides:
 * 1. Workflow base config (nodes)
 * 2. Ecosystem overrides (ecosystemOverrides)
 * 3. Model version overrides (versionOverrides)
 *
 * Priority: version > ecosystem > workflow
 */

import { ECO, ecosystemByKey, ecosystemById } from '~/shared/constants/basemodel.constants';
import {
  parseWorkflowKey,
  type WorkflowCategory,
  type WorkflowConfig,
  type WorkflowConfigs,
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

/** Image ecosystems that support txt2img */
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

/** Video ecosystems that support txt2vid */
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

/** Video ecosystems that support img2vid */
const IMG2VID_IDS = [
  ECO.HyV1,
  ECO.LTXV2,
  ECO.WanVideo,
  ECO.WanVideo14B_I2V_480p,
  ECO.WanVideo14B_I2V_720p,
  ECO.WanVideo22_TI2V_5B,
  ECO.WanVideo22_I2V_A14B,
  ECO.WanVideo25_I2V,
  ECO.Veo3,
  ECO.Sora2,
  ECO.Vidu,
  ECO.MiniMax,
  ECO.Kling,
  ECO.Haiper,
  ECO.Lightricks,
];

// =============================================================================
// Workflow Configs
// =============================================================================

export const workflowConfigs: WorkflowConfigs = {
  // ===========================================================================
  // Text to Image Workflows
  // ===========================================================================

  txt2img: {
    label: 'Create Image',
    description: 'Generate an image from a text prompt',
    category: 'text-to-image',
    ecosystemIds: TXT2IMG_IDS,
  },

  'txt2img:draft': {
    label: 'Draft',
    description: 'Fast generation for quick iterations',
    category: 'text-to-image',
    ecosystemIds: DRAFT_IDS,
  },

  'txt2img:face-fix': {
    label: 'Create + Face Fix',
    description: 'Generate with automatic face correction',
    category: 'text-to-image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  'txt2img:hires-fix': {
    label: 'Create + Hires Fix',
    description: 'Generate with upscaling for higher detail',
    category: 'text-to-image',
    ecosystemIds: SD_FAMILY_IDS,
  },

  // ===========================================================================
  // Image to Image Workflows
  // ===========================================================================

  img2img: {
    label: 'Image Variations',
    description: 'Create variations of an existing image',
    category: 'image-to-image',
    ecosystemIds: SD_FAMILY_IDS,
    nodes: {
      images: { max: 1, min: 1 },
    },
  },

  'img2img:face-fix': {
    label: 'Image Face Fix',
    description: 'Fix and enhance faces in an image',
    category: 'image-to-image',
    ecosystemIds: SD_FAMILY_IDS,
    nodes: {
      images: { max: 1, min: 1 },
    },
  },

  'img2img:hires-fix': {
    label: 'Image Hires Fix',
    description: 'Upscale and add detail to an image',
    category: 'image-to-image',
    ecosystemIds: SD_FAMILY_IDS,
    nodes: {
      images: { max: 1, min: 1 },
    },
  },

  'img2img:edit': {
    label: 'Image Edit',
    description: 'Edit specific parts of an image with prompts',
    category: 'image-to-image',
    ecosystemIds: [
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
    ],
    nodes: {
      images: { max: 7, min: 1 },
    },
    ecosystemOverrides: {
      Qwen: {
        images: { max: 1 },
      },
      Flux1Kontext: {
        images: { max: 1 },
      },
    },
  },

  // ===========================================================================
  // Image Enhancement Workflows (Standalone)
  // ===========================================================================

  'img2img:remove-background': {
    label: 'Remove Background',
    description: 'Remove the background from an image',
    category: 'image-enhancements',
    ecosystemIds: [],
    nodes: {
      images: { max: 1, min: 1 },
    },
  },

  'img2img:upscale': {
    label: 'Upscale',
    description: 'Increase image resolution',
    category: 'image-enhancements',
    ecosystemIds: [],
    nodes: {
      images: { max: 1, min: 1 },
    },
  },

  // ===========================================================================
  // Video Workflows
  // ===========================================================================

  txt2vid: {
    label: 'Create Video',
    description: 'Generate a video from a text prompt',
    category: 'text-to-video',
    ecosystemIds: TXT2VID_IDS,
  },

  img2vid: {
    label: 'Animate Image',
    description: 'Animate a still image into a video',
    category: 'image-to-video',
    ecosystemIds: IMG2VID_IDS,
    nodes: {
      images: { max: 1, min: 1 },
    },
  },

  'img2vid:first-last-frame': {
    label: 'First/Last Frame',
    description: 'Create video from start and end images',
    category: 'image-to-video',
    ecosystemIds: [ECO.Vidu],
    nodes: {
      images: {
        slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame' }],
      },
    },
  },

  'img2vid:ref2vid': {
    label: 'Reference Video',
    description: 'Generate video using a reference image',
    category: 'image-to-video',
    ecosystemIds: [ECO.Vidu],
    nodes: {
      images: { max: 7, min: 1 },
    },
  },

  // ===========================================================================
  // Video Enhancement Workflows
  // ===========================================================================

  'vid2vid:upscale': {
    label: 'Upscale',
    description: 'Increase video resolution',
    category: 'video-enhancements',
    ecosystemIds: [],
  },

  'vid2vid:interpolate': {
    label: 'Interpolate',
    description: 'Smooth video by adding frames',
    category: 'video-enhancements',
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

/** Lookup map for workflows by key */
export const workflowConfigByKey = new Map(workflowConfigsArray.map((w) => [w.key, w]));

// =============================================================================
// Workflow Option Type (for UI consumption)
// =============================================================================

export type WorkflowOption = {
  /** Workflow key */
  id: string;
  /** Display label */
  label: string;
  /** Brief description of what this workflow does */
  description?: string;
  /** Category for grouping in UI */
  category: WorkflowCategory;
  /** Input type required */
  inputType: 'text' | 'image' | 'video';
  /** If true, this workflow is ecosystem-specific */
  ecosystemSpecific?: boolean;
};

/**
 * Convert a workflow config to a workflow option.
 * Input type is derived from the workflow key.
 */
function toWorkflowOption(
  key: string,
  config: (typeof workflowConfigsArray)[number]
): WorkflowOption {
  const parsed = parseWorkflowKey(key);
  return {
    id: key,
    label: config.label,
    description: config.description,
    category: config.category,
    inputType: parsed.input,
    ecosystemSpecific: config.ecosystemIds.length === 1,
  };
}

/**
 * All workflow options derived from workflow configs.
 */
export const workflowOptions: WorkflowOption[] = workflowConfigsArray.map((w) =>
  toWorkflowOption(w.key, w)
);

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
 */
export function getWorkflowsForEcosystem(ecosystemId: number): WorkflowOption[] {
  return workflowOptions.filter((w) => isWorkflowAvailable(w.id, ecosystemId));
}

/**
 * Get all workflows grouped by category with compatibility info for an ecosystem.
 */
export function getWorkflowsWithCompatibility(ecosystemId: number): {
  category: WorkflowCategory;
  label: string;
  workflows: (WorkflowOption & { compatible: boolean })[];
}[] {
  const categories: { category: WorkflowCategory; label: string }[] = [
    { category: 'text-to-image', label: 'Text to Image' },
    { category: 'image-to-image', label: 'Image to Image' },
    { category: 'image-enhancements', label: 'Enhancements' },
    { category: 'text-to-video', label: 'Text to Video' },
    { category: 'image-to-video', label: 'Image to Video' },
    { category: 'video-enhancements', label: 'Enhancements' },
  ];

  return categories.map(({ category, label }) => ({
    category,
    label,
    workflows: workflowOptions
      .filter((w) => w.category === category)
      .map((w) => ({ ...w, compatible: isWorkflowAvailable(w.id, ecosystemId) })),
  }));
}

/**
 * Get all workflows grouped by category (without compatibility info).
 * Used when all workflows should be shown regardless of ecosystem.
 */
export function getAllWorkflowsGrouped(): {
  category: WorkflowCategory;
  label: string;
  workflows: (WorkflowOption & { compatible: boolean })[];
}[] {
  const categories: { category: WorkflowCategory; label: string }[] = [
    { category: 'text-to-image', label: 'Text to Image' },
    { category: 'image-to-image', label: 'Image to Image' },
    { category: 'image-enhancements', label: 'Enhancements' },
    { category: 'text-to-video', label: 'Text to Video' },
    { category: 'image-to-video', label: 'Image to Video' },
    { category: 'video-enhancements', label: 'Enhancements' },
  ];

  return categories.map(({ category, label }) => ({
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
 * Derive input type from workflow key.
 */
export function getInputTypeForWorkflow(workflowId: string): 'text' | 'image' | 'video' {
  try {
    return parseWorkflowKey(workflowId).input;
  } catch {
    return 'text'; // fallback
  }
}

/**
 * Derive output type from workflow key.
 */
export function getOutputTypeForWorkflow(workflowId: string): 'image' | 'video' {
  try {
    const output = parseWorkflowKey(workflowId).output;
    return output === 'text' ? 'image' : output; // text output defaults to image
  } catch {
    return 'image'; // fallback
  }
}

/**
 * Get all workflows that accept a given media type as input.
 * Used to determine available actions for a generated output:
 * - Image output → workflows with image input (img2img*, img2vid*)
 * - Video output → workflows with video input (vid2vid*)
 */
export function getWorkflowsForOutputType(outputType: 'image' | 'video'): WorkflowOption[] {
  return workflowOptions.filter((w) => w.inputType === outputType);
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
