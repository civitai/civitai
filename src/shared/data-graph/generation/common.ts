/**
 * Common Node Builders for Generation Graph V2
 *
 * These builders create node definitions with meta containing ONLY dynamic props.
 * Static props (label, buttonLabel, placeholder, etc.) are defined in components.
 */

import z from 'zod';
import {
  baseModelByName,
  ecosystemById,
  ecosystemByKey,
  getCompatibleBaseModels,
  getDefaultModelId,
  getEcosystemSetting,
} from '~/shared/constants/basemodel.constants';
import { MAX_SEED, samplers } from '~/shared/constants/generation.constants';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the ecosystem key for a base model name.
 * E.g., "Veo 3" → "Veo3", "Hunyuan Video" → "HyV1"
 */
function getEcosystemKeyForBaseModel(baseModelName: string): string | undefined {
  const baseModel = baseModelByName.get(baseModelName);
  if (!baseModel) return undefined;
  const ecosystem = ecosystemById.get(baseModel.ecosystemId);
  return ecosystem?.key;
}

// =============================================================================
// Aspect Ratio Types & Node Builder
// =============================================================================

/** Aspect ratio option type */
export type AspectRatioOption = {
  label: string;
  value: string;
  width: number;
  height: number;
};

/**
 * Creates an aspect ratio node with the given options.
 * Meta contains only: options (dynamic based on model)
 */
export function aspectRatioNode({
  options,
  defaultValue,
}: {
  options: AspectRatioOption[];
  defaultValue?: string;
}) {
  const defaultOption = options.find((o) => o.value === (defaultValue ?? '1:1')) ?? options[0];
  return {
    input: z
      .union([
        z.string(),
        z.object({
          value: z.string(),
          width: z.number().optional(),
          height: z.number().optional(),
        }),
      ])
      .optional()
      .transform((val) => {
        if (!val) return defaultOption;

        // Try exact match first
        const value = typeof val === 'string' ? val : val.value;
        const exactMatch = options.find((o) => o.value === value);
        if (exactMatch) return exactMatch;

        // If input has dimensions, find closest by aspect ratio
        if (typeof val === 'object' && val.width && val.height) {
          return findClosestAspectRatio({ width: val.width, height: val.height }, options);
        }

        // Parse string value as aspect ratio (e.g., "16:9") and find closest
        const parts = value.split(':').map(Number);
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          return findClosestAspectRatio({ width: parts[0], height: parts[1] }, options);
        }

        return defaultOption;
      }),
    output: z.object({ value: z.string(), width: z.number(), height: z.number() }),
    defaultValue: defaultOption,
    meta: {
      options,
    },
  };
}

// =============================================================================
// Prompt Node Builder
// =============================================================================

/**
 * Creates a prompt node.
 * No meta - all props (label, placeholder, etc.) are static.
 */
export function promptNode({ required }: { required?: boolean } = {}) {
  let output = z.string().max(1500, 'Prompt is too long');
  if (required) output = output.nonempty('Prompt is required');
  return {
    input: z.string().optional(),
    output,
    defaultValue: '',
  };
}

/**
 * Creates a negative prompt node.
 * No meta - all props are static.
 */
export function negativePromptNode({ maxLength = 1000 }: { maxLength?: number } = {}) {
  return {
    input: z.string().optional(),
    output: z.string().max(maxLength, 'Negative prompt is too long'),
    defaultValue: '',
  };
}

// =============================================================================
// Slider Node Builders
// =============================================================================

/** Default sampler presets */
const defaultSamplerPresets = [
  { label: 'Fast', value: 'Euler a' },
  { label: 'Popular', value: 'DPM++ 2M Karras' },
];

/**
 * Creates a sampler node.
 * Meta contains: options, presets (dynamic - could vary by model)
 */
export function samplerNode({
  options = samplers,
  defaultValue = 'Euler a',
  presets = defaultSamplerPresets,
}: {
  options?: readonly string[];
  defaultValue?: string;
  presets?: Array<{ label: string; value: string }>;
} = {}) {
  return {
    output: z.string(),
    defaultValue,
    meta: {
      options: options.map((s) => ({ label: s, value: s })),
      presets,
    },
  };
}

/** Default CFG scale presets */
const defaultCfgScalePresets = [
  { label: 'Creative', value: 4 },
  { label: 'Balanced', value: 7 },
  { label: 'Precise', value: 10 },
];

/**
 * Creates a CFG Scale node.
 * Meta contains: min, max, step, presets (dynamic - varies by model family)
 */
export function cfgScaleNode({
  min = 1,
  max = 10,
  step = 0.5,
  defaultValue = 7,
  presets = defaultCfgScalePresets,
}: {
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  presets?: Array<{ label: string; value: number }>;
} = {}) {
  return {
    input: z.coerce.number().min(min).max(max).optional(),
    output: z.number().min(min).max(max),
    defaultValue,
    meta: {
      min,
      max,
      step,
      presets,
    },
  };
}

/** Default steps presets */
const defaultStepsPresets = [
  { label: 'Fast', value: 15 },
  { label: 'Balanced', value: 25 },
  { label: 'High', value: 35 },
];

/**
 * Creates a steps node.
 * Meta contains: min, max, step, presets (dynamic - varies by model)
 */
export function stepsNode({
  min = 10,
  max = 50,
  step = 1,
  defaultValue = 25,
  presets = defaultStepsPresets,
}: {
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  presets?: Array<{ label: string; value: number }>;
} = {}) {
  return {
    input: z.coerce.number().int().min(1).max(max).optional(),
    output: z.number().int().min(1).max(max),
    defaultValue,
    meta: {
      min,
      max,
      step,
      presets,
    },
  };
}

/**
 * Creates a CLIP Skip node.
 * Meta contains: min, max, step, presets (dynamic)
 */
export function clipSkipNode({
  min = 1,
  max = 3,
  step = 1,
  defaultValue = 2,
  presets,
}: {
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  presets?: Array<{ label: string; value: number }>;
} = {}) {
  return {
    input: z.coerce.number().int().min(min).max(12).optional(),
    output: z.number().int().min(min).max(12),
    defaultValue,
    meta: {
      min,
      max,
      step,
      presets,
    },
  };
}

/**
 * Creates a seed node.
 * No meta - no dynamic props.
 */
export function seedNode() {
  return {
    input: z.union([z.undefined(), z.coerce.number().int().min(0).max(MAX_SEED)]).optional(),
    output: z.number().int().optional(),
    defaultValue: undefined,
  };
}

// =============================================================================
// Resource Schemas & Node Builders
// =============================================================================

const resourceSchema = z.object({
  id: z.number(),
  strength: z.number().optional(),
  baseModel: z.string(),
  model: z.object({
    type: z.string(),
  }),
});

const resourceInputSchema = z.union([
  z.number().transform((id) => ({ id })),
  z.looseObject({ id: z.number() }),
]);

function getResourceSelectOptions(baseModel: string, resourceTypes: ModelType[]) {
  const ecosystem = ecosystemByKey.get(baseModel);
  return resourceTypes
    .map((type) => {
      const compatible = ecosystem
        ? getCompatibleBaseModels(ecosystem.id, type)
        : { full: [], partial: [] };
      return {
        type,
        baseModels: compatible.full.map((m) => m.name),
        partialSupport: compatible.partial.map((m) => m.name),
      };
    })
    .filter((r) => r.baseModels.length > 0 || r.partialSupport.length > 0);
}

/** Version option for checkpoint subgraph */
export type CheckpointVersionOption = {
  label: string;
  value: number;
};

/**
 * Creates a checkpoint subgraph with model node and ecosystem sync effect.
 *
 * This subgraph includes:
 * - model: The checkpoint node with optional version options in meta
 * - An effect that syncs baseModel when the model changes to a different ecosystem
 *
 * The model node:
 * - Validates that loaded models are compatible with the current baseModel ecosystem
 * - Only allows checkpoints with FULL support for the ecosystem (no partial support)
 * - Falls back to the default model for the ecosystem if incompatible
 *
 * @param versions - Optional list of version options for mode switching (e.g., Flux modes)
 * @returns A DataGraph subgraph for checkpoint selection with ecosystem sync
 *
 * @example
 * ```ts
 * // Standard checkpoint
 * const checkpointGraph = createCheckpointGraph();
 *
 * // With versions (e.g., Flux modes)
 * const fluxCheckpointGraph = createCheckpointGraph({
 *   versions: [
 *     { label: 'Standard', value: 691639 },
 *     { label: 'Ultra', value: 1088507 },
 *   ],
 * });
 * ```
 */
export function createCheckpointGraph({
  versions,
}: {
  versions?: CheckpointVersionOption[];
} = {}) {
  return new DataGraph<{ baseModel: string }, GenerationCtx>()
    .node(
      'model',
      (ctx, ext) => {
        const baseModel = ctx.baseModel;
        const resourceIds = ext.resources.map((x) => x.id);

        const ecosystem = ecosystemByKey.get(baseModel);
        const modelVersionId = ecosystem ? getDefaultModelId(ecosystem.id) : undefined;
        const modelLocked = ecosystem
          ? getEcosystemSetting(ecosystem.id, 'modelLocked') ?? false
          : false;
        const compatibleBaseModels = ecosystem
          ? getCompatibleBaseModels(ecosystem.id, 'Checkpoint').full.map((m) => m.name)
          : [];

        // Input schema that preserves the baseModel field for validation
        const checkpointInputSchema = z
          .union([
            z.number().transform((id) => ({ id })),
            z.looseObject({ id: z.number(), baseModel: z.string().optional() }),
          ])
          .optional()
          .transform((val) => {
            if (!val) return undefined;
            // Validate that the model is compatible with the current baseModel ecosystem
            const modelBaseModel = 'baseModel' in val ? val.baseModel : undefined;
            if (modelBaseModel) {
              // If we have compatible base models defined, check against them
              if (compatibleBaseModels.length > 0) {
                if (!compatibleBaseModels.includes(modelBaseModel)) {
                  return undefined;
                }
              } else {
                // No compatible base models defined (e.g., video ecosystems)
                // Check if the model's ecosystem matches the current baseModel ecosystem
                const modelEcosystemKey = getEcosystemKeyForBaseModel(modelBaseModel);
                if (modelEcosystemKey && modelEcosystemKey !== baseModel) {
                  return undefined;
                }
              }
            }
            return val;
          });

        return {
          input: checkpointInputSchema,
          output: resourceSchema.optional(),
          defaultValue: modelVersionId
            ? { id: modelVersionId, baseModel, model: { type: 'Checkpoint' } }
            : undefined,
          meta: {
            options: {
              canGenerate: true,
              resources: getResourceSelectOptions(baseModel, ['Checkpoint']),
              excludeIds: resourceIds,
            },
            modelLocked,
            versions,
          },
        };
      },
      ['baseModel']
    )
    .effect(
      (ctx, _ext, set) => {
        const model = ctx.model as { id?: number; baseModel?: string } | undefined;
        // Only run if we have a valid model with both id and baseModel
        if (!model?.baseModel || !model.id) {
          return;
        }

        const modelEcosystemKey = getEcosystemKeyForBaseModel(model.baseModel);
        // If we can't determine the ecosystem, or they already match, nothing to do
        if (!modelEcosystemKey || modelEcosystemKey === ctx.baseModel) {
          return;
        }

        // Update baseModel to match the model's ecosystem
        set('baseModel', modelEcosystemKey);
      },
      ['model']
    );
}

/**
 * Creates an additional resources (LoRA, etc.) node.
 * Meta contains: options, limit (dynamic based on baseModel and external context)
 */
export function resourcesNode({
  baseModel,
  resourceTypes = ['TextualInversion', 'LORA', 'LoCon', 'DoRA'] as ModelType[],
  resourceIds = [],
  limit = 12,
}: {
  baseModel: string;
  resourceTypes?: ModelType[];
  resourceIds?: number[];
  limit?: number;
}) {
  const resources = getResourceSelectOptions(baseModel, resourceTypes);

  return {
    input: resourceInputSchema.array().optional(),
    output: resourceSchema
      .array()
      .max(limit, 'You have exceeded the maximum number of allowed resources')
      .optional(),
    defaultValue: [],
    meta: {
      options: {
        canGenerate: true,
        resources,
        excludeIds: resourceIds,
      },
      limit,
    },
  };
}

/**
 * Creates a VAE node.
 * Meta contains only: options (dynamic based on baseModel)
 */
export function vaeNode({
  baseModel,
  resourceIds = [],
}: {
  baseModel: string;
  resourceIds?: number[];
}) {
  const resources = getResourceSelectOptions(baseModel, ['VAE']);

  return {
    input: resourceInputSchema.optional(),
    output: resourceSchema.optional(),
    meta: {
      options: {
        canGenerate: true,
        resources,
        excludeIds: resourceIds,
      },
    },
  };
}

// =============================================================================
// Input Graphs (text vs image input)
// =============================================================================

/**
 * Text input graph (for txt2img/txt2vid).
 * Just a prompt - no images.
 */
export const textInputGraph = new DataGraph<Record<never, never>, GenerationCtx>().node(
  'prompt',
  promptNode({ required: true })
);

/**
 * Image input graph (for img2img/img2vid).
 * Prompt (optional) and source images.
 * Note: denoise is added per-workflow via denoiseNode().
 */
export const imageInputGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  .node('prompt', promptNode({ required: false }))
  .node('images', {
    input: z
      .union([z.url(), z.object({ url: z.string })])
      .array()
      .optional()
      .transform((arr) => arr?.map((item) => (typeof item === 'string' ? { url: item } : item))),
    output: z
      .object({ url: z.string(), width: z.number(), height: z.number() })
      .array()
      .min(1, 'At least one image is required'),
    defaultValue: [],
  });

// =============================================================================
// Denoise Node Builder
// =============================================================================

/**
 * Creates a denoise strength node.
 * Meta contains: min, max, step (dynamic - could vary by workflow)
 */
export function denoiseNode({
  min = 0,
  max = 1,
  step = 0.05,
  defaultValue = 0.75,
}: {
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
} = {}) {
  return {
    input: z.coerce.number().min(min).max(max).optional(),
    output: z.number().min(min).max(max),
    defaultValue,
    meta: {
      min,
      max,
      step,
    },
  };
}

// =============================================================================
// Enhanced Compatibility Node Builder
// =============================================================================

/**
 * Creates an enhanced compatibility toggle node.
 * No meta - all props are static.
 */
export function enhancedCompatibilityNode() {
  return {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  };
}

// =============================================================================
// Video Node Types & Builder
// =============================================================================

/** Video metadata type */
export type VideoMetadata = {
  fps: number;
  width: number;
  height: number;
  duration: number;
};

/** Video value type (URL with optional metadata) */
export type VideoValue = {
  url: string;
  metadata?: VideoMetadata;
};

/** Zod schema for video metadata */
const videoMetadataSchema = z.object({
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  duration: z.number(),
});

/** Zod schema for video value */
const videoValueSchema = z.object({
  url: z.string(),
  metadata: videoMetadataSchema.optional(),
});

/**
 * Creates a video source node.
 * Accepts a URL string or a full video object with metadata.
 * The component fetches metadata and provides the full output.
 */
export function videoNode() {
  return {
    input: z.union([z.string().transform((url) => ({ url })), videoValueSchema]).optional(),
    output: videoValueSchema.optional(),
    defaultValue: undefined,
  };
}
