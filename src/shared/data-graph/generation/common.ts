/**
 * Common Node Builders for Generation Graph V2
 *
 * These builders create node definitions with meta containing ONLY dynamic props.
 * Static props (label, buttonLabel, placeholder, etc.) are defined in components.
 */

import z from 'zod';
import { videoValueSchema, videoMetadataSchema } from './media-schemas';
import { snippetReferenceSchema, type SnippetReferenceValue } from '../schemas/snippet-schema';

export const MAX_PROMPT_LENGTH = 6000;
export const MAX_NEGATIVE_PROMPT_LENGTH = 6000;
import {
  baseModelByName,
  ecosystemById,
  ecosystemByKey,
  getCompatibleBaseModels,
  getEcosystemDefaults,
  getGenerationSupport,
  filterCompatibleResources,
} from '~/shared/constants/basemodel.constants';
import { MAX_SEED, samplers } from '~/shared/constants/generation.constants';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { rulesToStates } from './gates';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { isWorkflowAvailable, getWorkflowsForEcosystem, workflowConfigByKey } from './config';
import {
  controlNetPreprocessors,
  controlNetCategoryLabels,
  type ControlNetPreprocessorKey,
  type ControlNetCategory,
  type ControlNetPreprocessorInfo,
} from '~/shared/constants/controlnets.constants';

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

/** Snap a value to the nearest step multiple and clamp to [min, max]. */
function snapToStep(val: number, step: number, min: number, max: number): number {
  const precision = Math.max(0, -Math.floor(Math.log10(step)));
  const snapped = Math.round(val / step) * step;
  const rounded = parseFloat(snapped.toFixed(precision));
  return Math.min(Math.max(rounded, min), max);
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
 * Meta contains: options (dynamic based on model) and optional priorityOptions
 * (subset of values shown before the "More" overflow button in the UI).
 */
export function aspectRatioNode({
  options,
  defaultValue,
  priorityOptions,
}: {
  options: AspectRatioOption[];
  defaultValue?: string;
  priorityOptions?: string[];
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
      priorityOptions,
    },
  };
}

// =============================================================================
// Text Node Builder
// =============================================================================

/**
 * Single-source-of-truth shape for every text-editor node in the generation
 * graph. Both the static helpers (`promptNode`, `negativePromptNode`) and the
 * reactive factory (`createTextEditorGraph`) compose this — so every node
 * keyed `prompt` / `negativePrompt` / `lyrics` / `musicDescription` exposes
 * an identical `meta` shape regardless of which surface produced it.
 *
 * Keeping the shape uniform matters at the type level: `Controller`'s
 * `CtxMeta['<key>']` is the union of metas across all discriminator
 * branches. If two branches emit different meta shapes for the same key,
 * TypeScript collapses safe access down to the common subset — which is
 * how `meta.snippets` previously came back as `{}` on wan's negativePrompt
 * but worked on every other ecosystem.
 *
 * The `snippets` / `triggerWords` fields are overlays — callers pass them
 * in when they have reactive data from ctx; the static helpers leave them
 * as `undefined` / `[]`.
 */
type TextNodeOptions<K extends string> = {
  name: K;
  maxLength?: number;
  emptyMessage?: string;
  required?: boolean;
  placeholder?: string;
  info?: string;
  /** Reactive overlay — `undefined` means snippets feature not active. */
  snippets?: SnippetReference[];
  /** Reactive overlay — `[]` means no trigger words active. */
  triggerWords?: string[];
};

export function textNode<const K extends string>(opts: TextNodeOptions<K>) {
  const {
    name,
    maxLength = MAX_PROMPT_LENGTH,
    emptyMessage,
    required = false,
    placeholder,
    info,
    snippets,
    triggerWords = [],
  } = opts;

  let output = z.string().trim().max(maxLength, `${name} is too long`);
  if (required) output = output.nonempty(emptyMessage ?? `${name} is required`);

  return {
    input: z.string().optional(),
    output,
    defaultValue: '',
    meta: {
      required,
      targetKey: name,
      snippets,
      triggerWords,
      placeholder,
      info,
    },
  };
}

// =============================================================================
// Prompt Node Builders
// =============================================================================

/**
 * Static prompt node. Same shape as `createTextEditorGraph` produces — see
 * `textNode` for the rationale. Use when an ecosystem needs a custom `when`
 * predicate or wraps the node with extra logic and can't compose the
 * reactive `promptGraph` directly.
 */
export function promptNode({ required }: { required?: boolean } = {}) {
  return textNode({ name: 'prompt', required, emptyMessage: 'Prompt is required' });
}

/**
 * Static negative-prompt node. Same shape as `createTextEditorGraph`
 * produces — see `textNode` for the rationale. Used by ecosystems like
 * `wan-graph` that gate negativePrompt visibility on workflow and so wrap
 * the node manually with a `when` predicate. Snippets/triggerWords aren't
 * reactive here; callers needing those features should compose
 * `negativePromptGraph` instead.
 */
export function negativePromptNode({
  maxLength = MAX_NEGATIVE_PROMPT_LENGTH,
}: { maxLength?: number } = {}) {
  return textNode({ name: 'negativePrompt', maxLength });
}

// =============================================================================
// Snippets / Wildcard Sets
// =============================================================================

/**
 * Per-form payload that carries which wildcard sets the user has loaded plus
 * the submission-mode toggles and the per-target snippet references. Mirrors
 * the `SnippetsNode` shape spec'd in docs/features/prompt-snippets-v1.md:
 *
 * - `wildcardSetIds`: set IDs active at submit time.
 * - `mode`: `'random'` (default) or `'batch'` — how the resolver fans out.
 * - `batchCount`: how many workflow steps the submission expands into.
 * - `seed`: preview-only override; only present when the user hit "Preview"
 *   before submit. Used by the resolver so the form's preview and the
 *   server-side resolution produce identical expansions. NOT persisted to
 *   workflow metadata — remixes intentionally get fresh randomness. Distinct
 *   from the image-gen seed on `seedNode`.
 * - `targets`: `Record<targetKey, SnippetReference[]>`. The set of target
 *   keys (e.g. `prompt`, `negativePrompt`) tells the orchestrator which
 *   editor nodes accept snippet references in this subgraph. v1 always
 *   submits with empty `SnippetReference[]` per target — the orchestrator
 *   parses actual `#refs` server-side from the template — and the parsed
 *   snapshot is what's persisted to workflow.metadata after submit.
 *   `in`/`ex` selections stay empty until the per-value picker UI ships.
 */
export type {
  SnippetReferenceSelectionValue,
  SnippetReferenceValue,
} from '../schemas/snippet-schema';

export type SnippetsNodeValue = {
  wildcardSetIds: number[];
  mode: 'random' | 'batch';
  batchCount: number;
  seed?: number;
  targets: Record<string, SnippetReferenceValue[]>;
};

// Each field carries its v1 default at the schema level so a partial value
// arriving via input (preset load, remix, dev-page `defaultValues`) parses
// to the full shape without a separate transform — and the strict output
// type stays `{ wildcardSetIds, mode, batchCount, targets, seed? }`.
const snippetsSchema = z.object({
  wildcardSetIds: z.array(z.number().int().positive()).default([]),
  mode: z.enum(['random', 'batch']).default('random'),
  batchCount: z.number().int().positive().default(1),
  seed: z.number().int().positive().optional(),
  targets: z.record(z.string(), z.array(snippetReferenceSchema)).default({}),
});

/**
 * Build a snippets node. The `targets` map starts empty — text editors
 * register themselves into it via the effect added by `createTextEditorGraph`
 * (see §"Text Editor Subgraphs" below). The orchestrator iterates
 * `Object.keys(snippets.targets)` at submit time to know which fields to
 * substitute.
 *
 * This inverts the responsibility from "the ecosystem subgraph declares
 * which targets exist" to "each text editor announces itself as a target,"
 * so adding a new editor is a one-place change in `createTextEditorGraph`'s
 * caller — the snippets node doesn't need to be told.
 */
export function snippetsNode() {
  return {
    input: snippetsSchema.optional(),
    output: snippetsSchema,
    defaultValue: {
      wildcardSetIds: [] as number[],
      mode: 'random' as const,
      batchCount: 1,
      targets: {} as Record<string, SnippetReferenceValue[]>,
    } satisfies SnippetsNodeValue,
  };
}

/**
 * Snippets subgraph. Merge `.merge(snippetsGraph)` into an ecosystem subgraph
 * alongside the text editors that should support `#category` references.
 * No target list is needed — each text editor registers itself as a target
 * via an effect from `createTextEditorGraph` when this graph is also merged.
 *
 * Gated behind the `wildcards` feature flag: when the flag is off, the node
 * is hidden (`when: false`) and never appears in validated workflow data.
 * Downstream consumers degrade cleanly — the editor's snippets-registration
 * effect short-circuits on missing ctx, the orchestrator's
 * `getSnippetOverlays` returns the trivial `[{}]` overlay (no fan-out),
 * and the form's autocomplete-on-`#` simply never fires because there's no
 * snippets meta to drive it.
 *
 * Workflows without any snippet-eligible text editor (vid2vid:upscale,
 * img2img:remove-background, etc.) deliberately omit this merge so the
 * validated workflow data doesn't carry an unused snippets node.
 *
 * Must be merged BEFORE the text editors it feeds — they declare `snippets`
 * in their deps and read its slice for chip rendering / target meta, and
 * their registration effects assume the snippets node is reachable.
 */
// Ctx requirement is the empty object: snippetsGraph reads nothing off ctx;
// it only contributes the `snippets` output node. Using `{}` (rather than
// `Record<string, never>`, which mapped every key to `never` and caused the
// merge-side intersection to collapse to `never`) lets it merge cleanly into
// any parent graph regardless of that parent's own keys.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const snippetsGraph = new DataGraph<{}, GenerationCtx>().node(
  'snippets',
  (_ctx, ext) => ({
    ...snippetsNode(),
    when: !!ext.flags?.wildcards,
  }),
  []
);

// =============================================================================
// Select Node Builders
// =============================================================================

/**
 * Creates a string select node — the shared primitive for sampler/scheduler nodes.
 * Input falls back to the resolved default when the value is not in options.
 * Meta contains: options, presets (optional)
 */
function selectNode({
  options,
  defaultValue,
  presets,
}: {
  options: readonly string[];
  defaultValue?: string;
  presets?: Array<{ label: string; value: string }>;
}) {
  const resolvedDefault =
    defaultValue && options.includes(defaultValue) ? defaultValue : options[0];
  return {
    input: z
      .string()
      .optional()
      .transform((val) => {
        if (!val) return undefined;
        if (options.includes(val)) return val;
        return resolvedDefault;
      }),
    output: z.enum(options),
    defaultValue: resolvedDefault,
    meta: {
      options: options.map((s) => ({ label: s, value: s })),
      presets,
    },
  };
}

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
  defaultValue,
  presets = defaultSamplerPresets,
}: {
  options?: readonly string[];
  defaultValue?: string;
  presets?: Array<{ label: string; value: string }>;
} = {}) {
  return selectNode({ options, defaultValue, presets });
}

/**
 * Creates a scheduler node (for SdCpp-based ecosystems like Flux2 Klein, ZImage).
 * Meta contains: options (dynamic - varies by ecosystem)
 */
export function schedulerNode({
  options,
  defaultValue,
}: {
  options: readonly string[];
  defaultValue?: string;
}) {
  return selectNode({ options, defaultValue });
}

// =============================================================================
// Slider Node Builder
// =============================================================================

/**
 * Creates a generic numeric slider node.
 * Meta contains: min, max, step, presets (for UI rendering)
 *
 * @param integer - When true, validates that the value is a whole number. If not specified, inferred from step (true if step is a whole number).
 */
export function sliderNode({
  min,
  max,
  step = 1,
  defaultValue,
  presets,
}: {
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  presets?: Array<{ label: string; value: number }>;
}) {
  const resolvedDefault = defaultValue ?? min;

  return {
    input: z.coerce
      .number()
      .optional()
      .transform((val) => {
        if (val === undefined) return undefined;
        return snapToStep(val, step, min, max);
      }),
    output: z.number().min(min).max(max),
    defaultValue: resolvedDefault,
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
    input: z
      .union([z.null(), z.undefined(), z.coerce.number().int().min(1).max(MAX_SEED)])
      .optional()
      .transform((val) => (val === null ? undefined : val)),
    output: z.number().int().min(1).max(MAX_SEED).optional(),
    defaultValue: undefined,
  };
}

// =============================================================================
// Enum Node Builder
// =============================================================================

/** Option type for enum node */
export type EnumOption<T extends string | number> = {
  label: string;
  value: T;
};

/**
 * Creates an enum node with type-safe options.
 * Input validates against allowed values, output is the enum type.
 * Meta contains: options (for UI rendering)
 *
 * Supports both string and numeric values. Numeric values are coerced
 * from strings on input (e.g., SegmentedControl passes string values).
 *
 * @example
 * // String enum
 * .node('style', enumNode({
 *   options: [
 *     { label: 'General', value: 'general' },
 *     { label: 'Anime', value: 'anime' },
 *   ],
 *   defaultValue: 'general',
 * }))
 *
 * // Numeric enum
 * .node('duration', enumNode({
 *   options: [
 *     { label: '5 seconds', value: 5 },
 *     { label: '10 seconds', value: 10 },
 *   ],
 *   defaultValue: 5,
 * }))
 */
export function enumNode<T extends string | number>({
  options,
  defaultValue,
}: {
  options: readonly EnumOption<T>[];
  defaultValue?: T;
}) {
  const values = options.map((o) => o.value);
  const isNumeric = typeof values[0] === 'number';

  // Coerce to the option type and validate against allowed values
  const coerce = isNumeric ? z.coerce.number() : z.coerce.string();
  const schema = coerce.refine((v) => values.includes(v as T)) as unknown as z.ZodType<T>;

  return {
    input: schema.optional(),
    output: schema,
    defaultValue: defaultValue ?? values[0],
    meta: {
      options,
    },
  };
}

// =============================================================================
// Quantity Node Builder
// =============================================================================

export interface QuantityNodeConfig {
  /** Maximum quantity (typically `ext.limits.maxQuantity`) */
  max: number;
  /** Minimum quantity (default: value of `step`) */
  min?: number;
  /** Step increment (default: 1) */
  step?: number;
}

/**
 * Creates a quantity node config with configurable min/step/max.
 * Caller passes `max` from external context (typically `ext.limits.maxQuantity`)
 * so this stays a plain builder — the node's (ctx, ext) callback owns the
 * lookup and any conditional logic.
 *
 * Meta contains: min, max, step (for UI rendering)
 *
 * @example
 * .node(
 *   'quantity',
 *   (_ctx, ext) => quantityNode({ max: ext.limits.maxQuantity }),
 *   []
 * )
 */
export function quantityNode({ max, min: minOpt, step: stepOpt }: QuantityNodeConfig) {
  const step = stepOpt ?? 1;
  const min = minOpt ?? step;
  return {
    input: z.coerce
      .number()
      .optional()
      .transform((val) => {
        if (val === undefined) return undefined;
        return snapToStep(val, step, min, max);
      }),
    output: z.number().min(min).max(max),
    defaultValue: min,
    meta: { min, max, step },
  };
}

// =============================================================================
// Resource Schemas & Node Builders
// =============================================================================

/**
 * Minimal resource schema for graph validation.
 *
 * Only validates fields that the client needs to send:
 * - id: Required to identify the resource
 * - baseModel: Required for ecosystem switching when model changes
 * - model.type: Required for routing resources to appropriate graph nodes
 * - strength: Optional LoRA/LoCon/DoRA strength
 * - epochDetails: Optional epoch training info
 *
 * Server-side enrichment (via getResourceData) adds model.name, air, etc.
 * Handlers receive AIR strings via GenerationHandlerCtx instead of computing them.
 */
export const resourceSchema = z.object({
  id: z.number(),
  baseModel: z.string().optional(),
  model: z.object({
    type: z.string(),
  }),
  strength: z.number().optional(),
  trainedWords: z.array(z.string()).optional(),
  epochDetails: z
    .object({
      epochNumber: z.number().optional(),
    })
    .optional(),
});

/** Resource data type inferred from resourceSchema (minimal client-side data) */
export type ResourceData = z.infer<typeof resourceSchema>;

/**
 * Value type of the `resources` node — a flat array of `ResourceData`. Mirrors
 * the `SnippetsNodeValue` naming so callers reading the graph snapshot have a
 * canonical name to cast against (e.g. `graph.getSnapshot() as { resources?:
 * ResourcesNodeValue }`) instead of redeclaring the shape inline.
 */
export type ResourcesNodeValue = ResourceData[];

const resourceInputSchema = z.union([
  z.number().transform((id) => ({ id })),
  z.looseObject({ id: z.number() }),
]);

function getResourceSelectOptions(ecosystem: string, resourceTypes: ModelType[]) {
  const ecosystemData = ecosystemByKey.get(ecosystem);
  return resourceTypes
    .map((type) => {
      const compatible = ecosystemData
        ? getCompatibleBaseModels(ecosystemData.id, type)
        : { full: [], partial: [] };
      return {
        type,
        baseModels: compatible.full.map((m) => m.name),
        partialSupport: compatible.partial.map((m) => m.name),
      };
    })
    .filter((r) => r.baseModels.length > 0 || r.partialSupport.length > 0);
}

// =============================================================================
// Version Option Types
// =============================================================================

/**
 * Single version option for the model selector.
 * Can optionally have children for hierarchical selection (e.g., precision → variant).
 *
 * When `children` is present, `value` is the default model ID when this option is selected.
 * When `children` is absent (leaf), `value` is the actual model version ID.
 */
export type VersionOption = {
  label: string;
  value: number;
  /** Base model name for this version (used for ecosystem switching) */
  baseModel?: string;
  /** Child options shown when this option is selected */
  children?: VersionGroup;
};

/**
 * Group of version options with an optional label.
 * The label is displayed above the selector control in the UI.
 *
 * @example
 * // Flat versions (Flux modes):
 * { options: [{ label: 'Draft', value: 123 }, { label: 'Standard', value: 456 }] }
 *
 * // Hierarchical versions (HiDream precision + variant):
 * {
 *   label: 'Precision',
 *   options: [
 *     { label: 'FP8', value: 1771369, children: {
 *       label: 'Variant',
 *       options: [{ label: 'Fast', value: 1770945 }, { label: 'Dev', value: 1771369 }]
 *     }},
 *   ]
 * }
 */
export type VersionGroup = {
  /** Optional label for this level of the selector (e.g., "Precision", "Variant") */
  label?: string;
  /** Available options at this level */
  options: VersionOption[];
};

/** @deprecated Use VersionOption instead */
export type CheckpointVersionOption = VersionOption;

/**
 * Collect all version IDs from a VersionGroup (including nested children).
 * Used for validation and version ID pre-registration.
 */
export function getAllVersionIds(group: VersionGroup): Set<number> {
  const ids = new Set<number>();
  function collect(g: VersionGroup) {
    for (const opt of g.options) {
      ids.add(opt.value);
      if (opt.children) collect(opt.children);
    }
  }
  collect(group);
  return ids;
}

/**
 * Returns a copy of `group` with any option whose `value` is in `hiddenIds`
 * removed. Recurses into `children`; a parent option is dropped when all of
 * its children are hidden, and a parent whose own `value` is hidden is
 * rewritten to point at the first remaining child so selecting the parent
 * doesn't land on a gated ID.
 *
 * Returns `undefined` when every option in the group is gated.
 */
export function filterVersionGroup(
  group: VersionGroup,
  hiddenIds: number[]
): VersionGroup | undefined {
  if (hiddenIds.length === 0) return group;
  const options: VersionOption[] = [];
  for (const opt of group.options) {
    if (opt.children) {
      const filteredChildren = filterVersionGroup(opt.children, hiddenIds);
      if (!filteredChildren) continue;
      const value = hiddenIds.includes(opt.value) ? filteredChildren.options[0].value : opt.value;
      options.push({ ...opt, value, children: filteredChildren });
    } else if (!hiddenIds.includes(opt.value)) {
      options.push(opt);
    }
  }
  if (options.length === 0) return undefined;
  return { ...group, options };
}

/**
 * Model node meta type for checkpoint graphs.
 * Kept in sync with the model node factory in createCheckpointGraph via return type annotation.
 */
export type CheckpointModelMeta = {
  options: {
    canGenerate: boolean;
    resources: { type: ModelType; baseModels: string[]; partialSupport: string[] }[];
    excludeIds: number[];
  };
  modelLocked: boolean;
  versions: VersionGroup | undefined;
  defaultModelId: number | undefined;
};

/**
 * Workflow-specific version configuration.
 * Maps workflow names to their version options and default model ID.
 *
 * @example
 * ```ts
 * const workflowVersions: WorkflowVersionConfig = {
 *   txt2vid: { versions: txt2vidVersions, defaultModelId: 123 },
 *   txt2img: { versions: img2imgVersions, defaultModelId: 456 },
 * };
 * ```
 */
export type WorkflowVersionConfig = Record<
  string,
  {
    versions: VersionGroup;
    defaultModelId: number;
  }
>;

/**
 * Find the workflow config for a given workflow key using prefix matching.
 * E.g., 'img2vid:ref2vid' will match the 'img2vid' config if using prefix matching.
 * First tries exact match, then prefix match (workflow starts with config key).
 */
function findWorkflowConfig(
  workflowVersions: WorkflowVersionConfig | undefined,
  workflow: string | undefined
): { versions: VersionGroup; defaultModelId: number } | undefined {
  if (!workflowVersions || !workflow) return undefined;

  // Try exact match first
  if (workflowVersions[workflow]) {
    return workflowVersions[workflow];
  }

  // Try prefix match (e.g., 'video:first-last-frame' matches 'video:' config key)
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
 * - Optionally, computed dimension nodes derived from model.id (e.g., precision, variant)
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
 *       versions: { options: fluxModeVersionOptions },
 *       modelLocked: ctx.workflow === 'txt2img:draft',
 *     }),
 *     ['workflow']
 *   );
 *
 * // With hierarchical versions (e.g., HiDream precision+variant)
 * const graph = new DataGraph()
 *   .merge(
 *     () => createCheckpointGraph({
 *       defaultModelId: 1771369,
 *       versions: {
 *         label: 'Precision',
 *         options: [
 *           { label: 'FP8', value: 1771369, children: { label: 'Variant', options: [...] } },
 *           { label: 'FP16', value: 1769068, children: { label: 'Variant', options: [...] } },
 *         ],
 *       },
 *     }),
 *     []
 *   );
 * ```
 */
type CheckpointGraphOptions = {
  /** Version options for the model selector (e.g., Flux modes, HiDream precision+variant) */
  versions?: VersionGroup;
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
};

/** Base Ctx/CtxValues types for the checkpoint graph */
type BaseCheckpointCtx = { workflow: string; ecosystem: string; model?: ResourceData };
type BaseCheckpointValues = { workflow: string; ecosystem: string; model: ResourceData };

export function createCheckpointGraph(
  options?: CheckpointGraphOptions
): DataGraph<
  BaseCheckpointCtx,
  GenerationCtx,
  { model: CheckpointModelMeta },
  BaseCheckpointValues
> {
  // Get versions and defaultModelId from workflowVersions if provided
  // Use prefix matching: 'img2vid:ref2vid' matches 'img2vid' config
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
      // Normalize workflow to match config keys (e.g., 'img2vid:ref2vid' -> 'img2vid')
      const workflow = getWorkflowKey(options.workflowVersions, rawWorkflow);

      // Skip if current model isn't a known version (user selected custom checkpoint)
      if (!allVersionIds.has(model.id)) return model;

      // Get target workflow config using the normalized key
      const targetConfig = options.workflowVersions![workflow];
      if (!targetConfig) return model;

      // Skip if model is already valid for current workflow
      const targetVersionIds = getAllVersionIds(targetConfig.versions);
      if (targetVersionIds.has(model.id)) return model;

      // Find equivalent version in target workflow
      const mapping = versionMappings.get(model.id);
      const equivalentVersion = mapping?.[workflow];
      if (equivalentVersion) {
        return {
          id: equivalentVersion.id,
          baseModel: equivalentVersion.baseModel,
          model: { type: 'Checkpoint' },
        } as any;
      }

      return model;
    };
  };

  const baseGraph = new DataGraph<{ workflow: string; ecosystem: string }, GenerationCtx>()
    .node(
      'model',
      (ctx, ext) => {
        const ecosystem = ecosystemByKey.get(ctx.ecosystem);
        const ecosystemDefaults = ecosystem ? getEcosystemDefaults(ecosystem.id) : undefined;
        const modelVersionId = defaultModelId ?? ecosystemDefaults?.model?.id;
        const modelLocked = options?.modelLocked ?? ecosystemDefaults?.modelLocked ?? false;

        // Drop any version targeted by a gate rule from the version selector so
        // users never see versions they can't use. Version pickers have no
        // shown-but-disabled affordance, so every gated state hides. Server
        // enforces the same gate in `getResourceCanGenerate` (hidden only).
        const ruleVersionIds = [...rulesToStates(ext.gateRules ?? []).modelVersionIds.keys()];
        const visibleVersions =
          versions && ruleVersionIds.length
            ? filterVersionGroup(versions, ruleVersionIds)
            : versions;

        const validVersionIds = visibleVersions ? getAllVersionIds(visibleVersions) : undefined;

        const checkpointInputSchema = z
          .union([
            z.number().transform((id) => ({ id })),
            z.looseObject({ id: z.number(), baseModel: z.string().optional() }),
          ])
          .optional()
          .transform((val) => {
            if (!val) return undefined;

            // When model is locked, force ecosystem default.
            // Stale stored values (from localStorage after ecosystem switches) are rejected.
            // Valid version options are allowed through for ecosystems with version selectors.
            if (modelLocked && modelVersionId && val.id !== modelVersionId) {
              if (!validVersionIds?.has(val.id)) {
                return { id: modelVersionId, model: { type: 'Checkpoint' } };
              }
            }

            // Ensure model.type is present for output schema conformance
            if (!('model' in val) || !val.model) {
              return { ...val, model: { type: 'Checkpoint' } };
            }
            return val;
          });

        return {
          input: checkpointInputSchema,
          output: resourceSchema.optional(),
          defaultValue: modelVersionId
            ? { id: modelVersionId, model: { type: 'Checkpoint' } }
            : undefined,
          // Meta is computed from value to derive excludeIds
          meta: (_ctx, _ext, value: ResourceData | undefined): CheckpointModelMeta => ({
            options: {
              canGenerate: true,
              resources: getResourceSelectOptions(ctx.ecosystem, ['Checkpoint']).map(
                ({ partialSupport, ...resources }) => ({ ...resources, partialSupport: [] })
              ),
              excludeIds: value ? [value.id] : [],
            },
            modelLocked,
            versions: visibleVersions,
            defaultModelId: modelVersionId,
          }),
          // Transform model when ecosystem or workflow changes
          transform: (model, ctx) => {
            const m = model as { id?: number; baseModel?: string } | undefined;
            // 1. Check ecosystem compatibility — reset model if it belongs to a different ecosystem
            if (m?.baseModel) {
              const modelEcosystemKey = getEcosystemKeyForBaseModel(m.baseModel);
              if (modelEcosystemKey && modelEcosystemKey !== ctx.ecosystem) {
                // Model doesn't belong to this ecosystem — use ecosystem default
                return modelVersionId
                  ? { id: modelVersionId, model: { type: 'Checkpoint' } }
                  : model;
              }
            }

            // 2. Apply workflow version transform if configured (e.g., Flux mode switching)
            const workflowTransform = buildModelTransform();
            if (workflowTransform) {
              return workflowTransform(model, ctx);
            }

            return model;
          },
        };
      },
      // Include 'workflow' in deps so transform runs when workflow changes
      options?.workflowVersions ? ['ecosystem', 'workflow'] : ['ecosystem']
    )
    .effect(
      (ctx, _ext, set) => {
        const model = ctx.model as { id?: number; baseModel?: string } | undefined;
        if (!model?.baseModel || !model.id) return;

        const modelEcosystemKey = getEcosystemKeyForBaseModel(model.baseModel);
        // Only switch ecosystem if the model's ecosystem differs from current
        if (!modelEcosystemKey || modelEcosystemKey === ctx.ecosystem) return;

        const targetEcosystem = ecosystemByKey.get(modelEcosystemKey);
        if (!targetEcosystem) return;

        const workflow = (ctx as { workflow?: string }).workflow ?? '';
        const workflowCompatible = isWorkflowAvailable(workflow, targetEcosystem.id);

        if (workflowCompatible) {
          // Current workflow is compatible - just switch ecosystem
          set('ecosystem', modelEcosystemKey);
        } else {
          // Current workflow is NOT compatible with model's ecosystem.
          // Find a compatible workflow for the model's ecosystem and switch both.
          const compatibleWorkflows = getWorkflowsForEcosystem(targetEcosystem.id);
          if (compatibleWorkflows.length > 0) {
            // Pick the first compatible workflow (usually the primary one like txt2vid or txt2img)
            const newWorkflow = compatibleWorkflows[0].id;
            // Set workflow first, then ecosystem - order matters for effect ordering
            set('workflow', newWorkflow);
            set('ecosystem', modelEcosystemKey);
          }
          // If no compatible workflows found, don't switch (shouldn't happen in practice)
        }
      },
      ['model']
    )
    // When model changes to a version excluded by the current workflow variant,
    // fall back to the parent workflow. This lets the user re-select the variant
    // from the dropdown, which will trigger the version constraint to force a valid model.
    .effect(
      (ctx, _ext, set) => {
        const workflow = (ctx as { workflow?: string }).workflow;
        if (!workflow) return;
        const config = workflowConfigByKey.get(workflow);
        if (!config?.variantOf || !config.excludeModelVersionIds?.length) return;
        const model = ctx.model as { id?: number } | undefined;
        if (model?.id && config.excludeModelVersionIds.includes(model.id)) {
          set('workflow', config.variantOf);
        }
      },
      ['model']
    )
    // When the selected checkpoint is a known version that isn't offered by the
    // current workflow but is by another (version options are workflow-scoped —
    // e.g. Boogu Edit / Edit-Turbo only exist on img2img:edit), switch to a
    // workflow that supports it. Lets a user open the form on such a checkpoint
    // (model page "Generate", remix) and land on the matching workflow.
    .effect(
      (ctx, _ext, set) => {
        if (!options?.workflowVersions) return;
        const modelId = (ctx.model as { id?: number } | undefined)?.id;
        if (!modelId || !allVersionIds?.has(modelId)) return;

        const rawWorkflow = (ctx as { workflow?: string }).workflow ?? '';
        const currentKey = getWorkflowKey(options.workflowVersions, rawWorkflow);
        const currentConfig = options.workflowVersions[currentKey];
        if (currentConfig && getAllVersionIds(currentConfig.versions).has(modelId)) return;

        const targetKey = Object.keys(options.workflowVersions).find((key) =>
          getAllVersionIds(options.workflowVersions![key].versions).has(modelId)
        );
        if (targetKey && targetKey !== currentKey) {
          set('workflow', targetKey);
        }
      },
      ['model']
    );

  // Cast needed: DataGraph infers `model` as required from .node('model', ...) but
  // BaseCheckpointCtx declares it optional (it doesn't exist before the node creates it).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return baseGraph as any;
}

/** Version mapping with id and optional baseModel */
type VersionMapping = { id: number; baseModel?: string };

/**
 * Builds a mapping from each version ID to its equivalent versions in other workflows.
 * Equivalence is determined by array index (e.g., first version maps to first version).
 * Now includes baseModel for ecosystem switching support.
 */
function buildVersionMappings(
  workflowVersions: WorkflowVersionConfig
): Map<number, Record<string, VersionMapping>> {
  const mappings = new Map<number, Record<string, VersionMapping>>();
  const workflows = Object.keys(workflowVersions);

  // For each workflow's versions, map to equivalent versions in other workflows
  for (const sourceWorkflow of workflows) {
    const sourceVersions = workflowVersions[sourceWorkflow].versions.options;

    for (let i = 0; i < sourceVersions.length; i++) {
      const sourceId = sourceVersions[i].value;
      const equivalents: Record<string, VersionMapping> = {};

      // Find equivalent version in each other workflow (same index)
      for (const targetWorkflow of workflows) {
        if (targetWorkflow === sourceWorkflow) continue;
        const targetVersions = workflowVersions[targetWorkflow].versions.options;
        if (i < targetVersions.length) {
          const targetVersion = targetVersions[i];
          equivalents[targetWorkflow] = {
            id: targetVersion.value,
            baseModel: targetVersion.baseModel,
          };
        }
      }

      mappings.set(sourceId, equivalents);
    }
  }

  return mappings;
}

/**
 * Creates an additional resources (LoRA, etc.) node.
 * Meta contains: options, limit (dynamic based on ecosystem)
 *
 * Meta is computed from the current value to derive excludeIds,
 * eliminating the need to pass resource IDs through external context.
 */
export function resourcesNode({
  ecosystem,
  resourceTypes = ['TextualInversion', 'LORA', 'LoCon', 'DoRA'] as ModelType[],
  limit = 12,
}: {
  ecosystem: string;
  resourceTypes?: ModelType[];
  limit?: number;
}) {
  const resources = getResourceSelectOptions(ecosystem, resourceTypes);

  return {
    input: resourceInputSchema.array().optional(),
    output: resourceSchema
      .array()
      .max(limit, 'You have exceeded the maximum number of allowed resources')
      .optional(),
    defaultValue: [],
    meta: (_ctx: unknown, _ext: unknown, value: ResourceData[] | undefined) => ({
      options: {
        canGenerate: true,
        resources,
        excludeIds: value?.map((r) => r.id) ?? [],
      },
      limit,
    }),
  };
}

/**
 * Creates a resources subgraph with ecosystem compatibility enforcement.
 * Wraps resourcesNode with an effect that filters out resources incompatible
 * with the current ecosystem whenever the ecosystem changes.
 *
 * Unlike a transform (which is skipped on direct updates), effects run after
 * any context change, so this catches resources arriving via graph.set() too.
 */
export function createResourcesGraph(options?: { resourceTypes?: ModelType[]; limit?: number }) {
  return new DataGraph<{ ecosystem: string }, GenerationCtx>()
    .node(
      'resources',
      (ctx, ext) =>
        resourcesNode({
          ecosystem: ctx.ecosystem,
          resourceTypes: options?.resourceTypes,
          limit: options?.limit ?? ext.limits.maxResources,
        }),
      // `ext:limits` re-runs the node when getStatus limits change so the
      // resource cap (`.max()` schema + meta.limit) tracks the live value.
      ['ecosystem', 'ext:limits']
    )
    .effect(
      (ctx, _ext, set) => {
        const resources = (ctx as { resources?: ResourceData[] }).resources;
        if (!resources?.length) return;
        const ecosystemData = ecosystemByKey.get(ctx.ecosystem);
        if (!ecosystemData) return;
        const filtered = filterCompatibleResources(ecosystemData.id, resources);
        if (filtered.length !== resources.length) {
          set('resources', filtered);
        }
      },
      ['ecosystem']
    );
}

/**
 * Creates an upscaler resource node (ecosystem-independent).
 * Unlike other resource nodes, upscalers aren't tied to any ecosystem,
 * so no baseModel filtering is applied.
 *
 * Meta is computed from the current value to derive excludeIds.
 */
export function upscalerNode() {
  return {
    input: resourceInputSchema.optional(),
    output: resourceSchema,
    defaultValue: { id: 164821, model: { type: 'Upscaler' } },
    meta: (_ctx: unknown, _ext: unknown, value: ResourceData | undefined) => ({
      options: {
        canGenerate: true,
        resources: [{ type: 'Upscaler' as ModelType }],
        excludeIds: value ? [value.id] : [],
      },
    }),
  };
}

/**
 * Creates a VAE node.
 * Meta contains only: options (dynamic based on ecosystem)
 *
 * Meta is computed from the current value to derive excludeIds.
 */
export function vaeNode({ ecosystem }: { ecosystem: string }) {
  const resources = getResourceSelectOptions(ecosystem, ['VAE']);

  return {
    input: resourceInputSchema.optional(),
    output: resourceSchema.optional(),
    meta: (_ctx: unknown, _ext: unknown, value: ResourceData | undefined) => ({
      options: {
        canGenerate: true,
        resources,
        excludeIds: value ? [value.id] : [],
      },
    }),
  };
}

/**
 * Creates a VAE subgraph with ecosystem compatibility enforcement.
 * Wraps vaeNode with an effect that clears the VAE if it's incompatible
 * with the current ecosystem whenever the ecosystem changes.
 */
export function createVaeGraph() {
  return new DataGraph<{ ecosystem: string }, GenerationCtx>()
    .node('vae', (ctx) => vaeNode({ ecosystem: ctx.ecosystem }), ['ecosystem'])
    .effect(
      (ctx, _ext, set) => {
        const vae = (ctx as { vae?: ResourceData }).vae;
        if (!vae?.baseModel) return;
        const ecosystemData = ecosystemByKey.get(ctx.ecosystem);
        if (!ecosystemData) return;
        const resourceEco = baseModelByName.get(vae.baseModel);
        if (!resourceEco) return;
        if (getGenerationSupport(ecosystemData.id, resourceEco.ecosystemId, 'VAE') === null) {
          set('vae', undefined);
        }
      },
      ['ecosystem']
    );
}

// =============================================================================
// Images Node Builder
// =============================================================================

/** Image slot configuration for named upload positions (e.g., first/last frame) */
export type ImageSlotConfig = {
  label: string;
  required?: boolean;
  /** When true, the slot cannot be interacted with (upload or remove) */
  disabled?: boolean;
};

export interface ImagesNodeConfig {
  /** Maximum number of images allowed (default: 1) */
  max?: number;
  /** Minimum number of images required (default: 1) */
  min?: number;
  /** Input label shown above the dropzone */
  label?: string;
  /** Helper text shown under the label */
  description?: string;
  /**
   * Named slots for fixed-position images (e.g., first/last frame).
   * When provided, renders side-by-side dropzones with labels.
   */
  slots?: ImageSlotConfig[];
  /**
   * Selectable modes that change how images input behaves.
   * Each mode maps to a workflow key — selecting a mode switches the workflow.
   */
  modes?: { label: string; value: string; workflow: string }[];
  /**
   * When true, warns the user if the uploaded image is missing AI generation metadata.
   * Used for video generation flows where source image metadata improves output quality.
   */
  warnOnMissingAiMetadata?: boolean;
  /**
   * Allowed aspect ratios for image cropping.
   * When provided, images are cropped to fit one of these aspect ratios on upload.
   */
  aspectRatios?: `${number}:${number}`[];
  /**
   * When true, crops subsequent images to match the first image's aspect ratio.
   */
  cropToFirstImage?: boolean;
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
export function imagesNode({
  min = 1,
  max = 1,
  label,
  description,
  slots,
  modes,
  warnOnMissingAiMetadata,
  aspectRatios,
  cropToFirstImage,
}: ImagesNodeConfig = {}) {
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
        effectiveMax === 1
          ? 'An image is required'
          : `At least ${effectiveMin} image${effectiveMin > 1 ? 's are' : ' is'} required`
      )
      .max(effectiveMax, `Maximum ${effectiveMax} image${effectiveMax > 1 ? 's' : ''} allowed`),
    defaultValue: [],
    meta: {
      min: effectiveMin,
      max: effectiveMax,
      label,
      description,
      slots,
      modes,
      warnOnMissingAiMetadata,
      aspectRatios,
      cropToFirstImage,
    },
  };
}

// =============================================================================
// ControlNets Node Builder
// =============================================================================

/**
 * Maximum number of ControlNet entries allowed across all ecosystems.
 *
 * Capped at 1 for the initial release — multi-ControlNet is a known
 * post-launch feature. The underlying graph node and UI both support `limit`
 * out of the box (UI uses `meta.limit` to gate the Add button and badge
 * `count/limit`), so lifting this cap is a one-line change here once the
 * orchestrator-side multi-CN work lands.
 */
export const CONTROLNET_LIMIT = 1;

/** Default weight bounds — matches orchestrator clamp. */
const CONTROLNET_WEIGHT_MIN = 0;
const CONTROLNET_WEIGHT_MAX = 2;
const CONTROLNET_WEIGHT_DEFAULT = 1;
const CONTROLNET_STEP_MIN = 0;
const CONTROLNET_STEP_MAX = 1;

const controlNetImageObjectSchema = z.object({
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});

// Image is optional on the input — users may stage an entry (pick category /
// preprocessor) before they've uploaded a reference. Entries without an image
// are filtered out at the array level before reaching `output`.
const controlNetImageInputSchema = z.union([z.string(), controlNetImageObjectSchema]);

/**
 * Mode for an individual ControlNet entry:
 * - `auto` (default): the uploaded image is raw — the backend runs the
 *   preprocessor on it before feeding it into the matching ControlNet model.
 * - `preprocessed`: the user uploaded an already-preprocessed control image
 *   (e.g. they ran canny themselves) — skip preprocessing and route the image
 *   straight to the matching ControlNet model.
 *
 * The `preprocessor` field still picks the ControlNet model in both modes;
 * mode only governs whether preprocessing runs.
 */
export const controlNetModes = ['auto', 'preprocessed'] as const;
export type ControlNetMode = (typeof controlNetModes)[number];

const controlNetEntryInputSchema = z.object({
  preprocessor: z.string(),
  mode: z.enum(controlNetModes).optional(),
  image: controlNetImageInputSchema.optional(),
  weight: z.coerce.number().min(CONTROLNET_WEIGHT_MIN).max(CONTROLNET_WEIGHT_MAX).optional(),
  startStep: z.coerce.number().min(CONTROLNET_STEP_MIN).max(CONTROLNET_STEP_MAX).optional(),
  endStep: z.coerce.number().min(CONTROLNET_STEP_MIN).max(CONTROLNET_STEP_MAX).optional(),
});

const controlNetEntryOutputSchema = z.object({
  preprocessor: z.string(),
  mode: z.enum(controlNetModes),
  image: controlNetImageObjectSchema,
  weight: z.number().min(CONTROLNET_WEIGHT_MIN).max(CONTROLNET_WEIGHT_MAX),
  startStep: z.number().min(CONTROLNET_STEP_MIN).max(CONTROLNET_STEP_MAX),
  endStep: z.number().min(CONTROLNET_STEP_MIN).max(CONTROLNET_STEP_MAX),
});

/** Runtime value type for a single ControlNet entry. */
export type ControlNetEntryValue = z.infer<typeof controlNetEntryOutputSchema>;

/** Runtime value type for the controlNets node — a flat array of entries. */
export type ControlNetsNodeValue = ControlNetEntryValue[];

/** Option type emitted in node meta for the UI to render select items. */
export type ControlNetPreprocessorOption = {
  value: ControlNetPreprocessorKey;
  label: string;
  description: string;
  category: ControlNetCategory;
  recommended: boolean;
  requiresPreprocessedImage: boolean;
};

/** Grouping of options under a category label, for grouped selects. */
export type ControlNetPreprocessorGroup = {
  category: ControlNetCategory;
  label: string;
  options: ControlNetPreprocessorOption[];
};

function toPreprocessorOption(
  key: ControlNetPreprocessorKey,
  info: ControlNetPreprocessorInfo
): ControlNetPreprocessorOption {
  return {
    value: key,
    label: info.label,
    description: info.description,
    category: info.category,
    recommended: info.recommended ?? false,
    requiresPreprocessedImage: info.requiresPreprocessedImage ?? false,
  };
}

/**
 * Creates a controlNets node.
 *
 * Pass the list of preprocessor keys the current ecosystem/model supports — the
 * node looks each one up in `controlNetPreprocessors` to build the select
 * options (with label, description, category, recommended flag) and groups
 * them by category for the UI. Any key not in the shared dictionary is dropped
 * with a warning rather than throwing, so a backend rollout that adds a new
 * preprocessor before the constants file is updated degrades gracefully.
 *
 * Meta exposes:
 * - `options`: flat list of preprocessor options (in input order)
 * - `groups`: same options grouped by category, with category labels
 * - `limit`: max number of controlnets that can be added at once
 * - `weight` / `step`: bounds + defaults for the per-entry sliders
 *
 * Output is an array of validated entries with defaults applied for
 * `weight` (1), `startStep` (0), `endStep` (1).
 *
 * @example
 * .node(
 *   'controlNets',
 *   () => controlNetsNode({
 *     preprocessors: ['canny', 'depthAnythingV2', 'dwpose', 'openpose'],
 *   }),
 *   []
 * )
 */
export function controlNetsNode({
  preprocessors,
  limit = 4,
}: {
  preprocessors: readonly ControlNetPreprocessorKey[];
  limit?: number;
}) {
  // Preserve caller-supplied order, dedupe, and drop unknown keys defensively.
  const seen = new Set<ControlNetPreprocessorKey>();
  const validKeys: ControlNetPreprocessorKey[] = [];
  for (const key of preprocessors) {
    if (seen.has(key)) continue;
    if (!controlNetPreprocessors[key]) continue;
    seen.add(key);
    validKeys.push(key);
  }

  const options = validKeys.map((key) => toPreprocessorOption(key, controlNetPreprocessors[key]));

  // Group by category, preserving the first-seen category order from `options`
  // so ecosystems that prioritize (e.g.) edges-first stay edges-first in the UI.
  const groupMap = new Map<ControlNetCategory, ControlNetPreprocessorOption[]>();
  for (const opt of options) {
    const bucket = groupMap.get(opt.category);
    if (bucket) bucket.push(opt);
    else groupMap.set(opt.category, [opt]);
  }
  const groups: ControlNetPreprocessorGroup[] = [...groupMap.entries()].map(([category, opts]) => ({
    category,
    label: controlNetCategoryLabels[category],
    options: opts,
  }));

  const allowedKeys = new Set(validKeys);
  // Refines `preprocessor: string` down to the ecosystem-allowed subset.
  const refinedInputSchema = controlNetEntryInputSchema.refine(
    (e) => allowedKeys.has(e.preprocessor as ControlNetPreprocessorKey),
    { message: 'Unsupported ControlNet preprocessor for this model', path: ['preprocessor'] }
  );

  return {
    input: refinedInputSchema
      .array()
      .max(limit)
      .optional()
      .transform((arr) => {
        if (!arr) return undefined;
        return arr.map((entry) => {
          const image = typeof entry.image === 'string' ? { url: entry.image } : entry.image;
          // Normalize a missing or empty-url image to `undefined` so the
          // array-level filter on `output` can drop incomplete entries.
          const normalizedImage = image?.url ? image : undefined;
          // Force mode to 'preprocessed' for preprocessors that require it;
          // otherwise default unset values to 'auto'.
          const info = controlNetPreprocessors[entry.preprocessor as ControlNetPreprocessorKey];
          const requiresPreprocessed = info?.requiresPreprocessedImage ?? false;
          const mode: ControlNetMode = requiresPreprocessed ? 'preprocessed' : entry.mode ?? 'auto';
          return {
            preprocessor: entry.preprocessor,
            mode,
            image: normalizedImage,
            weight: entry.weight ?? CONTROLNET_WEIGHT_DEFAULT,
            startStep: entry.startStep ?? CONTROLNET_STEP_MIN,
            endStep: entry.endStep ?? CONTROLNET_STEP_MAX,
          };
        });
      }),
    // Filter out entries without an image, then validate the remaining
    // entries against the output schema (where `image` is required).
    output: z
      .array(z.unknown())
      .max(limit, `Maximum ${limit} ControlNets allowed`)
      .optional()
      .transform((arr) =>
        arr?.filter(
          (e): e is { image: { url: string } } =>
            typeof e === 'object' &&
            e !== null &&
            'image' in e &&
            !!(e as { image?: { url?: string } }).image?.url
        )
      )
      .pipe(controlNetEntryOutputSchema.array().optional()),
    defaultValue: [] as ControlNetsNodeValue,
    meta: {
      options,
      groups,
      limit,
      weight: {
        min: CONTROLNET_WEIGHT_MIN,
        max: CONTROLNET_WEIGHT_MAX,
        default: CONTROLNET_WEIGHT_DEFAULT,
        step: 0.05,
      },
      step: {
        min: CONTROLNET_STEP_MIN,
        max: CONTROLNET_STEP_MAX,
        step: 0.05,
      },
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

// Re-exported from media-schemas.ts to avoid circular dependency TDZ errors
export { imageValueSchema, videoMetadataSchema, videoValueSchema } from './media-schemas';

/**
 * Creates a video source node.
 * Accepts a URL string or a full video object with metadata.
 * The component fetches metadata and provides the full output.
 *
 * Note: Output is required so validation fails when no video is provided.
 * The input is optional to allow clearing via graph.set({ video: undefined }).
 * Components must cast onChange to accept undefined for clearing.
 */
export function videoNode() {
  return {
    input: z.union([z.string().transform((url) => ({ url })), videoValueSchema]).optional(),
    output: z.object(
      { url: z.string(), metadata: videoMetadataSchema.optional() },
      { message: 'A video is required' }
    ),
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

// =============================================================================
// Text Editor Subgraphs (prompt, negativePrompt, lyrics, musicDescription, …)
// =============================================================================

/**
 * Re-export the canonical snippet value types under the names this file's
 * factory used historically. `createTextEditorGraph` reads `snippets.targets[name]`
 * for the per-target `SnippetReference[]` slice; both forms point at the same
 * underlying values defined above in §"Snippets / Wildcard Sets".
 */
export type SnippetReference = SnippetReferenceValue;
type SnippetsValue = SnippetsNodeValue;

/**
 * Single-source-of-truth `triggerWords` computed. Flattens trainedWords from
 * the active model + resources. Merge once per ecosystem subgraph that has
 * model and/or resources, BEFORE any text editors that want to read it —
 * the runtime walks entries in build order, so editors merged after this
 * graph re-run when triggerWords changes.
 *
 * Subgraphs without model/resources can skip the merge — text editors then
 * see `triggerWords` missing from ctx and fall back to `[]` in their meta.
 *
 * Usage: `.merge(triggerWordsGraph)`.
 */
export const triggerWordsGraph = new DataGraph<
  { model?: ResourceData; resources?: ResourceData[] },
  GenerationCtx
>().computed(
  'triggerWords',
  (ctx) => {
    const resources = (('resources' in ctx ? ctx.resources : undefined) ?? []) as ResourceData[];
    const model = ('model' in ctx ? ctx.model : undefined) as ResourceData | undefined;
    const all = model ? [model, ...resources] : resources;
    return all.flatMap((r) => r.trainedWords ?? []);
  },
  ['model', 'resources']
);

/**
 * Context the text-editor factory expects on the parent. Everything is
 * optional — the factory only reads what's actually present at runtime.
 */
type TextEditorParentCtx = {
  // Future submission-level snippets node. Optional until the feature ships.
  snippets?: SnippetsValue;
  // Surfaced in meta when the parent merged `triggerWordsGraph`.
  triggerWords?: string[];
};

type TextEditorRequiredFn = (ctx: Record<string, unknown>) => boolean;

type TextEditorOptions<K extends string> = {
  /** Node key — also the snippet target key (e.g. 'prompt', 'lyrics'). */
  name: K;
  /** Output max length. Defaults to MAX_PROMPT_LENGTH. */
  maxLength?: number;
  /** Validation message when `required` is true and the value is empty. */
  emptyMessage?: string;
  /**
   * Whether the field is required. May be a static boolean or a predicate
   * over the parent ctx (e.g. `ctx => !ctx.images?.length`).
   */
  required?: boolean | TextEditorRequiredFn;
  /**
   * Deps consumed by the `required` predicate. The factory always adds
   * `snippets` and `triggerWords` on top of these so editor meta refreshes
   * when chips change or the model/resources change.
   */
  requiredDeps?: readonly string[];
  /** Override placeholder for this editor (surfaced in `meta.placeholder`). */
  placeholder?: string;
  /** Override info-tooltip text for this editor (surfaced in `meta.info`). */
  info?: string;
};

/**
 * Build a text-editor subgraph: a single `.node(name, ...)` with snippet- and
 * triggerWords-aware meta. Use this for prompt, negativePrompt, lyrics,
 * musicDescription — anything that's a free-form text input on the form.
 *
 * Each editor's meta exposes:
 * - `required: boolean`
 * - `targetKey: string` — pairs with future `snippets.targets[targetKey]`
 * - `snippets: SnippetReference[] | undefined` — `undefined` when the parent subgraph
 *   didn't merge `snippetsGraph`; an array (possibly empty) when it did, carrying the
 *   per-target `SnippetReference[]` slice. Acts as both the feature flag (presence) and
 *   the data payload — the React-side editor opts into `#category` autocomplete + chip
 *   rendering whenever this is defined. No graph subscription required on the consumer side.
 * - `triggerWords: string[]` — empty when parent didn't merge `triggerWordsGraph`
 * - `placeholder?: string` — set by per-ecosystem override; consumer falls back to its own default
 * - `info?: string` — set by per-ecosystem override; consumer falls back to its own default
 *
 * Recommended merge order in an ecosystem subgraph:
 *   1. createCheckpointGraph()   (model)
 *   2. createResourcesGraph()    (resources, when applicable)
 *   3. triggerWordsGraph         (when applicable)
 *   4. snippetsGraph             (when prompt/negativePrompt are merged)
 *   5. promptGraph / negativePromptGraph / createTextEditorGraph(...)
 *
 * Usage:
 * ```ts
 * .merge(
 *   () => createTextEditorGraph({
 *     name: 'musicDescription',
 *     required: true,
 *     emptyMessage: 'Music description is required',
 *     maxLength: 1000,
 *   }),
 *   []
 * )
 * ```
 */
export function createTextEditorGraph<const K extends string>(opts: TextEditorOptions<K>) {
  const {
    name,
    maxLength = MAX_PROMPT_LENGTH,
    emptyMessage,
    required = false,
    requiredDeps = [],
    placeholder,
    info,
  } = opts;

  // Always react to snippets + triggerWords updates, plus whatever the
  // required-predicate cares about. Both keys are tolerated as missing
  // by the dep system, so subgraphs without them just see `[]` fallbacks.
  const editorDeps = ['snippets', 'triggerWords', ...requiredDeps] as const;

  return (
    new DataGraph<TextEditorParentCtx, GenerationCtx>()
      .node(
        name,
        (ctx) => {
          const isRequired =
            typeof required === 'function'
              ? required(ctx as unknown as Record<string, unknown>)
              : required;

          // Unified snippets meta: undefined when the parent subgraph didn't
          // merge `snippetsGraph`, otherwise an array (possibly empty) carrying
          // the per-target `SnippetReference[]` slice from `snippets.targets`.
          // Presence doubles as the feature flag for the React-side editor.
          const snippetsValue = ('snippets' in ctx ? ctx.snippets : undefined) as
            | SnippetsValue
            | undefined;
          const snippets: SnippetReference[] | undefined =
            'snippets' in ctx ? snippetsValue?.targets?.[name] ?? [] : undefined;

          // Trigger words — populated when the parent subgraph merged
          // triggerWordsGraph, otherwise falls back to [].
          const triggerWords = (('triggerWords' in ctx ? ctx.triggerWords : undefined) ??
            []) as string[];

          return textNode({
            name,
            maxLength,
            emptyMessage,
            required: isRequired,
            placeholder,
            info,
            snippets,
            triggerWords,
          });
        },
        editorDeps
      )
      // Registration effect: when the parent subgraph merged `snippetsGraph`,
      // announce this editor as a snippet target by writing its name into
      // `snippets.targets`. Subgraphs that didn't merge snippetsGraph have no
      // `snippets` in ctx — the effect short-circuits and is a no-op.
      //
      // Idempotency: the effect re-fires whenever `snippets` changes (e.g.
      // another sibling editor registered itself); the early-return on
      // "already present" prevents an infinite loop. Editors converge to a
      // stable `targets` map in a deterministic number of evaluation passes
      // (one per editor in the subgraph).
      .effect(
        (ctx, _ext, set) => {
          if (!('snippets' in ctx) || !ctx.snippets) return;
          const current = ctx.snippets as SnippetsValue;
          const existingTargets = current.targets ?? {};
          if (name in existingTargets) return;
          // `set`'s key type excludes the editor's own K (generic, so TS treats
          // K as potentially `"snippets"` and conservatively rejects writing to
          // it). The cast is safe because the editor name K is constrained to a
          // text-editor name by the caller — never `"snippets"`.
          (set as (key: 'snippets', value: SnippetsValue) => void)('snippets', {
            ...current,
            targets: { ...existingTargets, [name]: [] },
          });
        },
        ['snippets'] as const
      )
  );
}

/**
 * Standard prompt subgraph for image/video ecosystems.
 * Required when the parent's `images` dep is absent or empty (covers txt-only
 * ecosystems and img2img cases where the user hasn't attached anything yet).
 *
 * Edge cases needing a different rule (Kling V3, Grok always-required,
 * ace-audio simple/custom) should call `createTextEditorGraph(...)` directly
 * with their own `required` predicate.
 *
 * Usage: `.merge(promptGraph)`.
 */
export const promptGraph = createTextEditorGraph({
  name: 'prompt',
  required: (ctx) => {
    const images = ('images' in ctx ? ctx.images : undefined) as unknown[] | undefined;
    return !images?.length;
  },
  requiredDeps: ['images'],
});

/**
 * Standard negativePrompt subgraph. Never required.
 *
 * Usage: `.merge(negativePromptGraph)`.
 */
export const negativePromptGraph = createTextEditorGraph({
  name: 'negativePrompt',
  maxLength: MAX_NEGATIVE_PROMPT_LENGTH,
});
