import { z } from 'zod';
import { rootScope } from 'form-graph';
import type { FieldDef } from 'form-graph';
import type { VersionGroup } from './checkpoint';
import { MAX_SEED, sdxlAspectRatioBuckets } from '~/shared/constants/generation.constants';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { snippetReferenceSchema } from '~/shared/data-graph/schemas/snippet-schema';
import {
  controlNetCategoryLabels,
  controlNetPreprocessors,
  type ControlNetCategory,
  type ControlNetPreprocessorKey,
} from '~/shared/constants/controlnets.constants';
import {
  baseModelByName,
  ecosystemByKey,
  filterCompatibleResources,
  getCompatibleBaseModels,
  getGenerationSupport,
} from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';

// Copied from common.ts, which dies with the data-graph engine.
export const MAX_PROMPT_LENGTH = 6000;
export const MAX_NEGATIVE_PROMPT_LENGTH = 6000;
export type AspectRatioOption = {
  label: string;
  value: string;
  width: number;
  height: number;
};

export * from '../defs';
import { snapToStep, type NumberMeta } from '../defs';

/**
 * form-graph definitions mirroring the node builders in
 * `~/shared/data-graph/generation/common.ts` — same input leniency, same
 * output strictness, same transforms, so a ported family behaves identically
 * to its data-graph original. The differential suite is what proves that; when
 * one of these drifts from `common.ts`, the suite fails and THIS file is wrong.
 *
 * Naming: data-graph calls these "nodes" and spells the default `defaultValue`;
 * form-graph calls them definitions and spells it `default`. Everything else is
 * a straight transcription.
 */

// --- sliders / enums / seed ---------------------------------------------------

/** common.ts `seedNode` */
export const SEED: FieldDef<number | undefined> = {
  input: z
    .union([z.null(), z.undefined(), z.coerce.number().int().min(1).max(MAX_SEED)])
    .optional()
    .transform((val) => (val === null ? undefined : val)),
  output: z.number().int().min(1).max(MAX_SEED).optional(),
  default: undefined,
  // v1 stores seed globally (bare key), not per family
  scope: rootScope(),
};

/**
 * The standard edit-images field: present on every non-txt workflow,
 * remembered per workflow. The `'txt'` prefix test is one policy — do not
 * fork it per family.
 */
export function img2imgImages(config: Parameters<typeof imagesDef>[0]) {
  return workflowScoped(({ _ext }: { _ext: { workflow: string } }) =>
    !_ext.workflow.startsWith('txt') ? imagesDef(config) : null
  );
}

/**
 * v1 stores images/video per WORKFLOW (its 'workflow' storage group), not per
 * family — wrap the def fn so the resolved def carries that scope.
 */
export function workflowScoped<B extends { _ext: { workflow: string } }, D extends object | null>(
  fn: (bag: B) => D
): (bag: B) => D {
  return (bag) => {
    const def = fn(bag);
    return def && !('scope' in def) ? ({ ...def, scope: rootScope(bag._ext.workflow) } as D) : def;
  };
}

// --- aspect ratio -------------------------------------------------------------

export interface AspectRatioValue {
  value: string;
  width: number;
  height: number;
}
export interface AspectRatioMeta {
  options: AspectRatioOption[];
  priorityOptions?: string[];
}

/** common.ts `aspectRatioNode` */
export function aspectRatioDef(opts: {
  options: AspectRatioOption[];
  default?: string;
  priorityOptions?: string[];
}) {
  const options = opts.options;
  const defaultOption = options.find((o) => o.value === (opts.default ?? '1:1')) ?? options[0]!;
  const toValue = ({ value, width, height }: AspectRatioOption): AspectRatioValue => ({
    value,
    width,
    height,
  });
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
        if (!val) return toValue(defaultOption);
        const value = typeof val === 'string' ? val : val.value;
        const exact = options.find((o) => o.value === value);
        if (exact) return toValue(exact);
        if (typeof val === 'object' && val.width && val.height) {
          return toValue(findClosestAspectRatio({ width: val.width, height: val.height }, options));
        }
        const parts = value.split(':').map(Number);
        if (parts.length === 2 && !isNaN(parts[0]!) && !isNaN(parts[1]!)) {
          return toValue(findClosestAspectRatio({ width: parts[0]!, height: parts[1]! }, options));
        }
        return toValue(defaultOption);
      }),
    output: z.object({ value: z.string(), width: z.number(), height: z.number() }),
    default: toValue(defaultOption),
    meta: { options, ...(opts.priorityOptions ? { priorityOptions: opts.priorityOptions } : {}) },
  } satisfies FieldDef<AspectRatioValue, AspectRatioMeta>;
}

// --- text (prompt / negativePrompt) -------------------------------------------

export interface TextMeta {
  required: boolean;
  targetKey: string;
  /**
   * The editor's slice of `snippets.targets`; `undefined` when snippets are
   * off (no wildcards flag) or the editor is a plain node — presence is the
   * feature flag the React editor keys off, exactly as in v1.
   */
  snippets?: SnippetsValue['targets'][string];
  triggerWords: string[];
  placeholder?: string;
  info?: string;
}

/**
 * common.ts `textNode`: output trims and caps length. Requiredness is per-pass
 * (prompt is required only when no images are attached), so it lives at the
 * call site as an output spread — this definition carries the unconditional part.
 */
export function textDef(name: string, maxLength = MAX_PROMPT_LENGTH) {
  return {
    input: z.string().optional(),
    output: z.string().trim().max(maxLength, `${name} is too long`),
    default: '',
  } satisfies FieldDef<string>;
}

// --- snippets ------------------------------------------------------------------

export const snippetsSchema = z.object({
  wildcardSetIds: z.array(z.number().int().positive()).default([]),
  mode: z.enum(['random', 'batch']).default('random'),
  batchCount: z.number().int().positive().default(1),
  seed: z.number().int().positive().optional(),
  targets: z.record(z.string(), z.array(snippetReferenceSchema)).default({}),
});
export type SnippetsValue = z.infer<typeof snippetsSchema>;

export const SNIPPETS: FieldDef<SnippetsValue> = {
  input: snippetsSchema.optional(),
  output: snippetsSchema,
  default: { wildcardSetIds: [], mode: 'random', batchCount: 1, targets: {} },
};

// --- resources / model ---------------------------------------------------------

export const resourceSchema = z.object({
  id: z.number(),
  baseModel: z.string().optional(),
  model: z.object({ type: z.string() }),
  strength: z.number().optional(),
  trainedWords: z.array(z.string()).optional(),
  epochDetails: z.object({ epochNumber: z.number().optional() }).optional(),
});
export type ResourceData = z.infer<typeof resourceSchema>;

const resourceInputSchema = z.union([
  z.number().transform((id) => ({ id })),
  z.looseObject({ id: z.number() }),
]);

/** One row of the resource picker's filter: a model type + the base models it accepts. */
export interface ResourceSelectOption {
  type: ModelType;
  baseModels: string[];
  partialSupport: string[];
}

/** Copied from common.ts, which dies with the data-graph engine. */
export function getResourceSelectOptions(
  ecosystem: string,
  resourceTypes: ModelType[]
): ResourceSelectOption[] {
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

/** common.ts `createResourcesGraph`'s default addon types. */
const DEFAULT_RESOURCE_TYPES = ['TextualInversion', 'LORA', 'LoCon', 'DoRA'] as ModelType[];

export interface ResourcesMeta {
  options: { canGenerate: boolean; resources: ResourceSelectOption[]; excludeIds: number[] };
  limit: number;
}

/**
 * common.ts `resourcesNode` + `createResourcesGraph`: lenient array input,
 * strict capped output, the picker's type/baseModel filter in meta, and the
 * ecosystem-compatibility filter (an effect in v1, a `correct` here — the
 * oracle drops incompatible resources DURING parse, pinned by the suites).
 */
export function resourcesDef(opts: {
  ecosystem: string;
  limit: number;
  resourceTypes?: ModelType[];
  /**
   * v1 has two resource nodes: `createResourcesGraph` filters cross-ecosystem
   * resources (the default here), raw `resourcesNode` keeps them (ernie).
   */
  filterIncompatible?: boolean;
}) {
  const { ecosystem, limit } = opts;
  const resourceTypes = opts.resourceTypes ?? DEFAULT_RESOURCE_TYPES;
  const selectOptions = getResourceSelectOptions(ecosystem, resourceTypes);
  const ecosystemData = ecosystemByKey.get(ecosystem);
  return {
    input: resourceInputSchema.array().optional(),
    // .optional() mirrors v1's output schema; the state itself is never
    // undefined (default []), so the def's T stays ResourceData[]
    output: resourceSchema
      .array()
      .max(limit, 'You have exceeded the maximum number of allowed resources')
      .optional() as unknown as z.ZodType<ResourceData[]>,
    default: [],
    meta: (value) => ({
      options: {
        canGenerate: true,
        resources: selectOptions,
        excludeIds: value?.map((r) => r.id) ?? [],
      },
      limit,
    }),
    correct: (value) => {
      if (opts.filterIncompatible === false) return undefined;
      if (!value?.length || !ecosystemData) return undefined;
      const filtered = filterCompatibleResources(ecosystemData.id, value);
      if (filtered.length === value.length) return undefined;
      return {
        value: filtered,
        reason: 'ecosystem_incompatible',
        detail: { ecosystem, dropped: value.length - filtered.length },
      };
    },
  } satisfies FieldDef<ResourceData[], ResourcesMeta>;
}

/**
 * common.ts `vaeNode` + `createVaeGraph`: a single optional resource, no
 * default; an incompatible VAE is cleared (v1 effect → `correct`, parse-time
 * behaviour pinned by the suites).
 */
export function vaeDef(opts: { ecosystem: string }) {
  const selectOptions = getResourceSelectOptions(opts.ecosystem, ['VAE'] as ModelType[]);
  const ecosystemData = ecosystemByKey.get(opts.ecosystem);
  return {
    input: resourceInputSchema.optional(),
    output: resourceSchema.optional(),
    default: undefined,
    meta: (value) => ({
      options: {
        canGenerate: true,
        resources: selectOptions,
        excludeIds: value ? [value.id] : [],
      },
    }),
    correct: (value) => {
      if (!value?.baseModel || !ecosystemData) return undefined;
      const resourceEco = baseModelByName.get(value.baseModel);
      if (!resourceEco) return undefined;
      if (getGenerationSupport(ecosystemData.id, resourceEco.ecosystemId, 'VAE') !== null)
        return undefined;
      return {
        value: undefined,
        reason: 'ecosystem_incompatible',
        detail: { ecosystem: opts.ecosystem, baseModel: value.baseModel },
      };
    },
  } satisfies FieldDef<ResourceData | undefined, Omit<ResourcesMeta, 'limit'>>;
}

export interface CheckpointMeta {
  options: { canGenerate: boolean; resources: ResourceSelectOption[]; excludeIds: number[] };
  modelLocked: boolean;
  versions: VersionGroup | undefined;
  defaultModelId: number | undefined;
}

/**
 * common.ts `createCheckpointGraph`'s model node, minus the effects (those
 * become rules at the family level). The locked/ecosystem substitutions are
 * `correct` policies declared at the call site, so each note carries its reason.
 */
export const MODEL: FieldDef<ResourceData | undefined, CheckpointMeta> = {
  input: z
    .union([
      z.number().transform((id) => ({ id })),
      z.looseObject({ id: z.number(), baseModel: z.string().optional() }),
    ])
    .optional()
    .transform((val) => {
      if (!val) return undefined;
      if (!('model' in val) || !val.model) {
        return { ...val, model: { type: 'Checkpoint' } } as ResourceData;
      }
      return val as ResourceData;
    }),
  output: resourceSchema.optional(),
};

// --- media ----------------------------------------------------------------------

export interface ImageEntry {
  url: string;
  width: number;
  height: number;
}
export interface ImagesMeta {
  min: number;
  max: number;
  slots?: { label: string; required?: boolean }[];
  warnOnMissingAiMetadata?: boolean;
  aspectRatios?: string[];
}

/** common.ts `imagesNode`: min from required slots, max from slots length. */
export function imagesDef(config: {
  min?: number;
  max?: number;
  slots?: { label: string; required?: boolean }[];
  warnOnMissingAiMetadata?: boolean;
  aspectRatios?: string[];
}) {
  const max = config.slots?.length ?? config.max ?? 1;
  const min = config.slots ? config.slots.filter((s) => s.required).length : config.min ?? 1;
  const imageObject = z.object({
    url: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  });
  return {
    input: z
      .union([z.url(), imageObject])
      .array()
      .optional()
      .transform((arr) =>
        arr
          ? arr.slice(0, max).map((item) => (typeof item === 'string' ? { url: item } : item))
          : undefined
      ),
    output: z
      .object({ url: z.string(), width: z.number(), height: z.number() })
      .array()
      .min(
        min,
        max === 1
          ? 'An image is required'
          : `At least ${min} image${min > 1 ? 's are' : ' is'} required`
      )
      .max(max, `Maximum ${max} image${max > 1 ? 's' : ''} allowed`),
    default: [],
    meta: {
      min,
      max,
      slots: config.slots,
      warnOnMissingAiMetadata: config.warnOnMissingAiMetadata,
      aspectRatios: config.aspectRatios,
    },
  } satisfies FieldDef<ImageEntry[], ImagesMeta>;
}

const videoMetadataSchema = z.object({
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  duration: z.number(),
});
export type VideoValue = { url: string; metadata?: z.infer<typeof videoMetadataSchema> };

/** common.ts `videoNode` */
export const VIDEO: FieldDef<VideoValue | undefined> = {
  input: z
    .union([
      z.string().transform((url) => ({ url })),
      z.object({ url: z.string(), metadata: videoMetadataSchema.optional() }),
    ])
    .optional(),
  output: z.object(
    { url: z.string(), metadata: videoMetadataSchema.optional() },
    { message: 'A video is required' }
  ),
  default: undefined,
};

/** common.ts `samplerNode`'s default presets. */
export const defaultSamplerPresets = [
  { label: 'Fast', value: 'Euler a' },
  { label: 'Popular', value: 'DPM++ 2M Karras' },
];

// --- quantity -------------------------------------------------------------------

/** common.ts `quantityNode`: min and default both equal the step (draft = 4s). */
export function quantityDef(opts: { max: number; step?: number }) {
  const step = opts.step ?? 1;
  const min = step;
  const { max } = opts;
  return {
    input: z.coerce
      .number()
      .optional()
      .transform((val) => (val === undefined ? undefined : snapToStep(val, step, min, max))),
    output: z.number().min(min).max(max),
    default: min,
    meta: { min, max, step },
  } satisfies FieldDef<number, NumberMeta>;
}

/**
 * A bounded number that REFUSES out-of-range input (falls to the default with
 * the error recorded) instead of snapping — the v1 hand-written-node policy
 * (grok/kling durations, ltx frame count, wan shift), distinct from
 * `sliderDef`, which clamps.
 */
export function refusingRangeDef(opts: {
  min: number;
  max: number;
  step?: number;
  default: number;
}) {
  const { min, max, step = 1 } = opts;
  return {
    input: z.coerce.number().min(min).max(max).optional(),
    output: z.number().min(min).max(max),
    default: opts.default,
    meta: { min, max, step },
  } satisfies FieldDef<number, NumberMeta>;
}

// --- controlNets ----------------------------------------------------------------

const controlNetImageObjectSchema = z.object({
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});
const controlNetModes = ['auto', 'preprocessed'] as const;

const controlNetEntryInputSchema = z.object({
  preprocessor: z.string(),
  mode: z.enum(controlNetModes).optional(),
  image: z.union([z.string(), controlNetImageObjectSchema]).optional(),
  weight: z.coerce.number().min(0).max(2).optional(),
  startStep: z.coerce.number().min(0).max(1).optional(),
  endStep: z.coerce.number().min(0).max(1).optional(),
});

const controlNetEntryOutputSchema = z.object({
  // runtime-guaranteed: the def refines entries against its per-family
  // allowlist (a subset of these keys), so the narrow union is truthful
  preprocessor: z.enum(
    Object.keys(controlNetPreprocessors) as [
      ControlNetPreprocessorKey,
      ...ControlNetPreprocessorKey[]
    ]
  ),
  mode: z.enum(controlNetModes),
  image: controlNetImageObjectSchema,
  weight: z.number().min(0).max(2),
  startStep: z.number().min(0).max(1),
  endStep: z.number().min(0).max(1),
});
export type ControlNetEntry = z.infer<typeof controlNetEntryOutputSchema>;

export interface ControlNetOption {
  value: ControlNetPreprocessorKey;
  label: string;
  description: string;
  category: ControlNetCategory;
  recommended: boolean;
  requiresPreprocessedImage: boolean;
}

export interface ControlNetsMeta {
  options: ControlNetOption[];
  groups: { category: ControlNetCategory; label: string; options: ControlNetOption[] }[];
  limit: number;
  weight: { min: number; max: number; default: number; step: number };
  step: { min: number; max: number; step: number };
}

/**
 * common.ts `controlNetsNode`: lenient staged entries on input (missing image
 * allowed, forced-preprocessed modes applied), image-less entries filtered
 * before the strict output pass; category-grouped picker options in meta.
 */
export function controlNetsDef(opts: {
  preprocessors: readonly ControlNetPreprocessorKey[];
  limit?: number;
}) {
  const limit = opts.limit ?? 4;
  const seen = new Set<ControlNetPreprocessorKey>();
  const validKeys = opts.preprocessors.filter((key) => {
    if (seen.has(key) || !controlNetPreprocessors[key]) return false;
    seen.add(key);
    return true;
  });
  const allowedKeys = new Set<string>(validKeys);

  const options: ControlNetOption[] = validKeys.map((key) => {
    const info = controlNetPreprocessors[key];
    return {
      value: key,
      label: info.label,
      description: info.description,
      category: info.category,
      recommended: info.recommended ?? false,
      requiresPreprocessedImage: info.requiresPreprocessedImage ?? false,
    };
  });
  // group by category, preserving first-seen category order
  const groupMap = new Map<ControlNetCategory, ControlNetOption[]>();
  for (const opt of options) {
    const bucket = groupMap.get(opt.category);
    if (bucket) bucket.push(opt);
    else groupMap.set(opt.category, [opt]);
  }
  const groups = [...groupMap.entries()].map(([category, opts2]) => ({
    category,
    label: controlNetCategoryLabels[category],
    options: opts2,
  }));

  return {
    input: controlNetEntryInputSchema
      .refine((e) => allowedKeys.has(e.preprocessor), {
        message: 'Unsupported ControlNet preprocessor for this model',
        path: ['preprocessor'],
      })
      .array()
      .max(limit)
      .optional()
      .transform((arr) => {
        if (!arr) return undefined;
        return arr.map((entry) => {
          const image = typeof entry.image === 'string' ? { url: entry.image } : entry.image;
          const normalizedImage = image?.url ? image : undefined;
          const requiresPreprocessed =
            controlNetPreprocessors[entry.preprocessor as ControlNetPreprocessorKey]
              ?.requiresPreprocessedImage ?? false;
          return {
            preprocessor: entry.preprocessor,
            mode: requiresPreprocessed ? 'preprocessed' : entry.mode ?? 'auto',
            image: normalizedImage,
            weight: entry.weight ?? 1,
            startStep: entry.startStep ?? 0,
            endStep: entry.endStep ?? 1,
          };
        });
      }),
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
    // the oracle emits [] when nothing is staged, not undefined
    default: [],
    // v1 stores controlNets globally (bare key) so staged nets survive
    // ecosystem switches
    scope: rootScope(),
    meta: {
      options,
      groups,
      limit,
      weight: { min: 0, max: 2, default: 1, step: 0.05 },
      step: { min: 0, max: 1, step: 0.05 },
    },
  } satisfies FieldDef<ControlNetEntry[] | undefined, ControlNetsMeta>;
}

/** v1's Low/Balanced/High guidance presets — shared by chroma, flux, flux2 and pony-v7. */
export const guidancePresetsLowBalHigh = [
  { label: 'Low', value: 2 },
  { label: 'Balanced', value: 3.5 },
  { label: 'High', value: 7 },
];

export const SDXL_SQUARE_AR = aspectRatioDef({ options: sdxlAspectRatioBuckets, default: '1:1' });
