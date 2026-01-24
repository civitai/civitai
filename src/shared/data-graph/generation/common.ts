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
  getEcosystemDefaults,
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
    meta: {
      required,
    },
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
    output: z.enum(options),
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
// Enum Node Builder
// =============================================================================

/** Option type for enum node */
export type EnumOption<T extends string> = {
  label: string;
  value: T;
};

/**
 * Creates an enum node with type-safe options.
 * Input validates against allowed values, output is the enum type.
 * Meta contains: options (for UI rendering)
 *
 * @example
 * // Simple usage with string array
 * .node('style', enumNode({
 *   options: [
 *     { label: 'General', value: 'general' },
 *     { label: 'Anime', value: 'anime' },
 *   ],
 *   defaultValue: 'general',
 * }))
 *
 * // With explicit type
 * .node('mode', enumNode<'fast' | 'standard'>({
 *   options: [
 *     { label: 'Fast', value: 'fast' },
 *     { label: 'Standard', value: 'standard' },
 *   ],
 *   defaultValue: 'fast',
 * }))
 */
export function enumNode<T extends string>({
  options,
  defaultValue,
}: {
  options: readonly EnumOption<T>[];
  defaultValue: T;
}) {
  const values = options.map((o) => o.value) as [T, ...T[]];

  return {
    input: z.enum(values).optional(),
    output: z.enum(values),
    defaultValue,
    meta: {
      options,
    },
  };
}

// =============================================================================
// Quantity Node Builder
// =============================================================================

export interface QuantityNodeConfig {
  /** Minimum quantity (default: 1) */
  min?: number;
  /** Step increment (default: 1) */
  step?: number;
}

/**
 * Creates a quantity node with configurable min/step.
 * Max is always derived from external context (ext.limits.maxQuantity).
 *
 * Meta contains: min, max, step (for UI rendering)
 *
 * @example
 * // Default quantity (min: 1, step: 1)
 * .node('quantity', quantityNode(), [])
 *
 * // Draft mode quantity (min: 4, step: 4)
 * .node('quantity', quantityNode({ min: 4, step: 4 }), [])
 */
export function quantityNode(config?: QuantityNodeConfig) {
  return (_ctx: Record<string, unknown>, ext: GenerationCtx) => {
    const min = config?.min ?? 1;
    const step = config?.step ?? 1;
    const max = ext.limits.maxQuantity;

    return {
      input: z.coerce
        .number()
        .optional()
        .transform((val) => {
          if (val === undefined) return undefined;
          // Snap to step multiples (round up to nearest step) and clamp to max
          return Math.min(Math.ceil(val / step) * step, max);
        }),
      output: z.number().min(min).max(max),
      defaultValue: min,
      meta: {
        min,
        max,
        step,
      },
    };
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
    id: z.number(),
    type: z.string(),
  }),
});

/** Resource data type inferred from resourceSchema */
export type ResourceData = z.infer<typeof resourceSchema>;

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

/** Version option for checkpoint graph */
export type CheckpointVersionOption = {
  label: string;
  value: number;
};

/**
 * Workflow-specific version configuration.
 * Maps workflow names to their version options and default model ID.
 *
 * @example
 * ```ts
 * const workflowVersions: WorkflowVersionConfig = {
 *   txt2vid: { versions: txt2vidVersions, defaultModelId: 123 },
 *   img2vid: { versions: img2vidVersions, defaultModelId: 456 },
 * };
 * ```
 */
export type WorkflowVersionConfig = Record<
  string,
  {
    versions: CheckpointVersionOption[];
    defaultModelId: number;
  }
>;

/**
 * Find the workflow config for a given workflow key using prefix matching.
 * E.g., 'img2vid:first-last-frame' will match the 'img2vid' config.
 * First tries exact match, then prefix match (workflow starts with config key).
 */
function findWorkflowConfig(
  workflowVersions: WorkflowVersionConfig | undefined,
  workflow: string | undefined
): { versions: CheckpointVersionOption[]; defaultModelId: number } | undefined {
  if (!workflowVersions || !workflow) return undefined;

  // Try exact match first
  if (workflowVersions[workflow]) {
    return workflowVersions[workflow];
  }

  // Try prefix match (e.g., 'img2vid:first-last-frame' matches 'img2vid')
  for (const key of Object.keys(workflowVersions)) {
    if (workflow.startsWith(key)) {
      return workflowVersions[key];
    }
  }

  return undefined;
}

/**
 * Get the workflow key for matching in workflowVersions.
 * Returns the base workflow (before any colon).
 */
function getWorkflowKey(
  workflowVersions: WorkflowVersionConfig | undefined,
  workflow: string | undefined
): string {
  if (!workflowVersions || !workflow) return '';

  // Try exact match first
  if (workflowVersions[workflow]) {
    return workflow;
  }

  // Try prefix match
  for (const key of Object.keys(workflowVersions)) {
    if (workflow.startsWith(key)) {
      return key;
    }
  }

  return workflow;
}

/**
 * Creates a checkpoint graph with model node and baseModel sync effect.
 *
 * This creates a subgraph containing:
 * - A 'model' node for checkpoint selection
 * - An effect to sync baseModel when model changes to a different ecosystem
 * - Optionally, an effect to sync model versions when workflow changes
 *
 * Use with `.merge()` to include in a parent graph:
 *
 * @example
 * ```ts
 * // Static merge (no dynamic options)
 * const graph = new DataGraph()
 *   .merge(createCheckpointGraph());
 *
 * // Dynamic merge with callback (for dynamic modelLocked, versions, etc.)
 * const graph = new DataGraph()
 *   .merge(
 *     (ctx) => createCheckpointGraph({
 *       versions: fluxModeVersionOptions,
 *       modelLocked: ctx.workflow === 'txt2img:draft',
 *     }),
 *     ['workflow']
 *   );
 *
 * // Workflow-specific versions with automatic sync
 * const graph = new DataGraph()
 *   .merge(
 *     (ctx) => createCheckpointGraph({
 *       workflowVersions: {
 *         txt2vid: { versions: txt2vidVersions, defaultModelId: 123 },
 *         img2vid: { versions: img2vidVersions, defaultModelId: 456 },
 *       },
 *       currentWorkflow: ctx.workflow,
 *     }),
 *     ['workflow']
 *   );
 * ```
 */
export function createCheckpointGraph(options?: {
  /** Version options for the model selector (e.g., Flux modes) */
  versions?: CheckpointVersionOption[];
  /** Whether to lock the model (hide swap button) */
  modelLocked?: boolean;
  /** Default model version ID override */
  defaultModelId?: number;
  /**
   * Workflow-specific version configurations.
   * When provided with currentWorkflow, enables automatic model syncing when workflow changes.
   * Each workflow maps to its available versions and default model ID.
   */
  workflowVersions?: WorkflowVersionConfig;
  /** Current workflow value (required when using workflowVersions) */
  currentWorkflow?: string;
}) {
  // Get versions and defaultModelId from workflowVersions if provided
  // Use prefix matching: 'img2vid:first-last-frame' matches 'img2vid' config
  const workflowConfig = findWorkflowConfig(options?.workflowVersions, options?.currentWorkflow);
  const versions = workflowConfig?.versions ?? options?.versions;
  const defaultModelId = workflowConfig?.defaultModelId ?? options?.defaultModelId;

  // Build version ID mappings for workflow sync effect
  // Maps version IDs from one workflow to equivalent versions in other workflows
  // by matching array index (e.g., fast→fast, standard→standard)
  const versionMappings = options?.workflowVersions
    ? buildVersionMappings(options.workflowVersions)
    : undefined;

  // All valid version IDs across all workflows
  const allVersionIds = versionMappings ? new Set(versionMappings.keys()) : undefined;

  // Build transform function for workflow version syncing
  // This is captured by the node factory closure and uses fresh values each time
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildModelTransform = (): ((model: any, ctx: any) => any) | undefined => {
    if (!versionMappings || !allVersionIds || !options?.workflowVersions) return undefined;

    return (model, ctx) => {
      if (!model?.id) return model;

      // Cast to access workflow (only present when parent graph has workflow in context)
      const rawWorkflow = ctx.workflow ?? '';
      // Normalize workflow to match config keys (e.g., 'img2vid:first-last-frame' -> 'img2vid')
      const workflow = getWorkflowKey(options.workflowVersions, rawWorkflow);

      // Skip if current model isn't a known version (user selected custom checkpoint)
      if (!allVersionIds.has(model.id)) return model;

      // Get target workflow config using the normalized key
      const targetConfig = options.workflowVersions![workflow];
      if (!targetConfig) return model;

      // Skip if model is already valid for current workflow
      const targetVersionIds = new Set(targetConfig.versions.map((v) => v.value));
      if (targetVersionIds.has(model.id)) return model;

      // Find equivalent version in target workflow
      const mapping = versionMappings.get(model.id);
      const equivalentVersion = mapping?.[workflow];
      if (equivalentVersion) {
        return { id: equivalentVersion } as any;
      }

      return model;
    };
  };

  return new DataGraph<{ baseModel: string }, GenerationCtx>()
    .node(
      'model',
      (ctx, ext) => {
        const ecosystem = ecosystemByKey.get(ctx.baseModel);
        const ecosystemDefaults = ecosystem ? getEcosystemDefaults(ecosystem.id) : undefined;
        const modelVersionId = defaultModelId ?? ecosystemDefaults?.model?.id;
        const modelLocked = options?.modelLocked ?? ecosystemDefaults?.modelLocked ?? false;
        const compatibleBaseModels = ecosystem
          ? getCompatibleBaseModels(ecosystem.id, 'Checkpoint').full.map((m) => m.name)
          : [];

        const checkpointInputSchema = z
          .union([
            z.number().transform((id) => ({ id })),
            z.looseObject({ id: z.number(), baseModel: z.string().optional() }),
          ])
          .optional()
          .transform((val) => {
            if (!val) return undefined;
            const modelBaseModel = 'baseModel' in val ? val.baseModel : undefined;
            if (modelBaseModel) {
              if (compatibleBaseModels.length > 0) {
                if (!compatibleBaseModels.includes(modelBaseModel)) {
                  return undefined;
                }
              } else {
                const modelEcosystemKey = getEcosystemKeyForBaseModel(modelBaseModel);
                if (modelEcosystemKey && modelEcosystemKey !== ctx.baseModel) {
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
            ? ({
                id: modelVersionId,
                baseModel: ctx.baseModel,
                model: { type: 'Checkpoint' },
              } as any)
            : undefined,
          meta: {
            options: {
              canGenerate: true,
              resources: getResourceSelectOptions(ctx.baseModel, ['Checkpoint']),
              excludeIds: ext.resources?.map((x) => x.id) ?? [],
            },
            modelLocked,
            // Versions are always passed; showVersionSelector computed determines visibility
            versions,
          },
          // Transform model version when workflow changes (if workflowVersions configured)
          transform: buildModelTransform(),
        };
      },
      // Include 'workflow' in deps so transform runs when workflow changes
      options?.workflowVersions ? ['baseModel', 'workflow'] : ['baseModel']
    )
    .effect(
      (ctx, _ext, set) => {
        const model = ctx.model as { id?: number; baseModel?: string } | undefined;
        if (!model?.baseModel || !model.id) return;

        const modelEcosystemKey = getEcosystemKeyForBaseModel(model.baseModel);
        if (!modelEcosystemKey || modelEcosystemKey === ctx.baseModel) return;

        set('baseModel', modelEcosystemKey);
      },
      ['model']
    );
}

/**
 * Builds a mapping from each version ID to its equivalent versions in other workflows.
 * Equivalence is determined by array index (e.g., first version maps to first version).
 */
function buildVersionMappings(
  workflowVersions: WorkflowVersionConfig
): Map<number, Record<string, number>> {
  const mappings = new Map<number, Record<string, number>>();
  const workflows = Object.keys(workflowVersions);

  // For each workflow's versions, map to equivalent versions in other workflows
  for (const sourceWorkflow of workflows) {
    const sourceVersions = workflowVersions[sourceWorkflow].versions;

    for (let i = 0; i < sourceVersions.length; i++) {
      const sourceId = sourceVersions[i].value;
      const equivalents: Record<string, number> = {};

      // Find equivalent version in each other workflow (same index)
      for (const targetWorkflow of workflows) {
        if (targetWorkflow === sourceWorkflow) continue;
        const targetVersions = workflowVersions[targetWorkflow].versions;
        if (i < targetVersions.length) {
          equivalents[targetWorkflow] = targetVersions[i].value;
        }
      }

      mappings.set(sourceId, equivalents);
    }
  }

  return mappings;
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
// Images Node Builder
// =============================================================================

/** Image slot configuration for named upload positions (e.g., first/last frame) */
export type ImageSlotConfig = {
  label: string;
  required?: boolean;
};

export interface ImagesNodeConfig {
  /** Maximum number of images allowed (default: 1) */
  max?: number;
  /** Minimum number of images required (default: 1) */
  min?: number;
  /**
   * Named slots for fixed-position images (e.g., first/last frame).
   * When provided, renders side-by-side dropzones with labels.
   */
  slots?: ImageSlotConfig[];
}

/**
 * Creates an images node with hierarchical limits.
 * Meta contains: min, max, slots (for UI rendering)
 *
 * @example
 * // With parent context - limits derived from model/ecosystem/workflow
 * .node('images', imagesNode(), ['workflow', 'baseModel', 'model'])
 *
 * // With explicit config override
 * .node('images', imagesNode({ max: 5 }), [])
 *
 * // With slots for named positions
 * .node('images', imagesNode({
 *   slots: [
 *     { label: 'First Frame', required: true },
 *     { label: 'Last Frame' }
 *   ]
 * }), [])
 */
export function imagesNode({ min = 1, max = 1, slots }: ImagesNodeConfig) {
  // When slots are provided, max is derived from slots length
  const effectiveMax = slots?.length ?? max;
  const effectiveMin = slots ? slots.filter((s) => s.required).length : min;

  // Image object schema with required url and optional dimensions
  const imageObjectSchema = z.object({
    url: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  });

  return {
    input: z
      .union([z.url(), imageObjectSchema])
      .array()
      .optional()
      .transform((arr) => {
        if (!arr) return undefined;
        // Transform URLs to objects and limit to max
        return arr
          .slice(0, effectiveMax)
          .map((item) => (typeof item === 'string' ? { url: item } : item));
      }),
    output: z
      .object({ url: z.string(), width: z.number(), height: z.number() })
      .array()
      .min(
        effectiveMin,
        `At least ${effectiveMin} image${effectiveMin > 1 ? 's are' : ' is'} required`
      )
      .max(effectiveMax, `Maximum ${effectiveMax} image${effectiveMax > 1 ? 's' : ''} allowed`),
    defaultValue: [],
    meta: {
      min: effectiveMin,
      max: effectiveMax,
      slots,
    },
  };
}

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

// =============================================================================
// Scale Factor Node Builder
// =============================================================================

/** Scale factor option type */
export type ScaleFactorOption = {
  value: number;
  label: string;
  disabled: boolean;
  targetWidth: number;
  targetHeight: number;
};

export interface ScaleFactorNodeConfig {
  /** Available upscale multipliers (e.g., [2, 3, 4]) */
  multipliers: readonly number[];
  /** Maximum output resolution (longest side) */
  maxOutputResolution: number;
}

/**
 * Creates a scale factor node for upscaling workflows.
 * Computes available options based on source dimensions and max output resolution.
 *
 * Meta contains: options, canUpscale, sourceWidth, sourceHeight, maxOutputResolution
 *
 * @example
 * // Image upscale with x2, x3, x4 multipliers
 * .node(
 *   'scaleFactor',
 *   (ctx) => scaleFactorNode({
 *     multipliers: [2, 3, 4],
 *     maxOutputResolution: 4096,
 *     sourceWidth: ctx.images?.[0]?.width,
 *     sourceHeight: ctx.images?.[0]?.height,
 *   }),
 *   ['images']
 * )
 *
 * // Video upscale with x2, x3 multipliers
 * .node(
 *   'scaleFactor',
 *   (ctx) => scaleFactorNode({
 *     multipliers: [2, 3],
 *     maxOutputResolution: 2560,
 *     sourceWidth: ctx.video?.metadata?.width,
 *     sourceHeight: ctx.video?.metadata?.height,
 *   }),
 *   ['video']
 * )
 */
export function scaleFactorNode({
  multipliers,
  maxOutputResolution,
  sourceWidth,
  sourceHeight,
}: ScaleFactorNodeConfig & {
  /** Source media width */
  sourceWidth?: number;
  /** Source media height */
  sourceHeight?: number;
}) {
  const width = sourceWidth;
  const height = sourceHeight;
  const maxDimension = width && height ? Math.max(width, height) : undefined;

  // Build options based on current dimensions
  const options: ScaleFactorOption[] = multipliers.map((multiplier) => ({
    value: multiplier,
    label: `x${multiplier}`,
    disabled: maxDimension ? multiplier * maxDimension > maxOutputResolution : false,
    targetWidth: width ? multiplier * width : 0,
    targetHeight: height ? multiplier * height : 0,
  }));

  // Find the first non-disabled option as default
  const defaultOption = options.find((o) => !o.disabled);
  const defaultValue = defaultOption?.value ?? multipliers[0];

  // Calculate whether upscaling is possible at all
  const canUpscale = maxDimension
    ? maxDimension * Math.min(...multipliers) <= maxOutputResolution
    : true;

  // Schema bounds from multipliers
  const minMultiplier = Math.min(...multipliers);
  const maxMultiplier = Math.max(...multipliers);

  return {
    input: z.coerce.number().int().min(minMultiplier).max(maxMultiplier).optional(),
    output: z
      .number()
      .int()
      .min(minMultiplier)
      .max(maxMultiplier)
      .refine((val) => !maxDimension || val * maxDimension <= maxOutputResolution, {
        message: `Scale factor would exceed maximum output resolution of ${maxOutputResolution}px`,
      }),
    defaultValue,
    meta: {
      options,
      canUpscale,
      sourceWidth: width,
      sourceHeight: height,
      maxOutputResolution,
    },
  };
}

