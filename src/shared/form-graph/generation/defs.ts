import { z } from 'zod';
import { rootScope } from 'form-graph';
import type { FieldDef } from 'form-graph';
import type { VersionGroup } from './checkpoint';
import {
  CUSTOM_ASPECT_RATIO,
  MAX_SEED,
  flux1ProAspectRatioBuckets,
  flux1ProCustomDimensionLimits,
  fourMegapixelCustomDimensionLimits,
  sdxlCustomDimensionLimits,
  twoMegapixelCustomDimensionLimits,
  sdxlFullAspectRatioBuckets,
  sdxlFullPriorityAspectRatios,
} from '~/shared/constants/generation.constants';
import {
  findClosestAspectRatio,
  fitCustomDimensions,
  type CustomDimensionLimits,
} from '~/utils/aspect-ratio-helpers';
import { snippetReferenceSchema } from '~/shared/generation/schemas/snippet-schema';
import {
  controlNetCategoryLabels,
  controlNetPreprocessors,
  type ControlNetCategory,
  videoControlNetPreprocessors,
  type ControlNetPreprocessorKey,
  type VideoControlNetPreprocessorKey,
} from '~/shared/constants/controlnets.constants';
import {
  baseModelByName,
  ecosystemByKey,
  filterCompatibleResources,
  getCompatibleBaseModels,
  getGenerationSupport,
} from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';

export const MAX_PROMPT_LENGTH = 6000;
export const MAX_NEGATIVE_PROMPT_LENGTH = 6000;
export type AspectRatioOption = {
  label: string;
  value: string;
  width: number;
  height: number;
};

export * from '../defs';
import { cachedFactory } from 'form-graph';
import { snapToStep, type NumberMeta } from '../defs';

/**
 * The field definitions every generation family composes from. Each pairs a LENIENT
 * input schema with a STRICT output one: the wire accepts what callers actually send
 * (a bare number for a resource, a partial snippets object) and `parse().data` hands
 * the server a shape it can rely on. Widening the output schema of one of these
 * widens it for every family at once.
 *
 * 🔴 EVERY DEF WITH A CONSTRAINED OUTPUT NEEDS A `correct` OR A `coerce`, AND WHICH ONE
 * IS NOT A STYLE CHOICE. `store.set()` writes TRUSTED intent and skips `input` entirely,
 * so ingestion (remix, replay, append, preset) lands another family's value verbatim and
 * `validate()` refuses it — which the footer shows as a Generate button that does
 * nothing. Persisted state is NOT affected: storage rehydrates as a boundary entry, runs
 * `input`, and falls through to the default when that fails.
 *
 *   · `correct` — when `input` ALREADY rejects or normalises the same value, so the hook
 *     cannot see it on the parse path and is a no-op there. Emits a note.
 *   · `coerce` — when `input` is permissive for it (`textDef`'s bare `z.string()`).
 *     `coerce` runs for trusted writes ONLY, so the server still refuses. A `correct`
 *     here would turn a 400 into a silent truncate-and-bill on a billed path.
 *
 * Pinned by `def-constraint-correction.test.ts` (both directions) and by
 * `no-uncorrected-constrained-def.test.ts`, which fails when a new def has neither.
 */

// --- sliders / enums / seed ---------------------------------------------------

export const SEED: FieldDef<number | undefined> = {
  input: z
    .union([z.null(), z.undefined(), z.coerce.number().int().min(1).max(MAX_SEED)])
    .optional()
    .transform((val) => (val === null ? undefined : val)),
  output: z.number().int().min(1).max(MAX_SEED).optional(),
  default: undefined,
  // 🔴 DROPPED, not clamped, and SILENTLY — nothing renders the note. A trusted `set()`
  // skips the input union above, so an out-of-contract seed reaches `validate()` and
  // refuses, killing the Generate button. The backend takes uint32, so clamping would
  // submit a DIFFERENT seed dressed as the original; dropping gives an honest random one.
  //
  // Tested against `output` rather than the bounds: `> MAX_SEED || < 1` is false for NaN
  // and misses 1.5, both of which arrive from `?gen=` handoffs and parsed metadata.
  correct: (value) =>
    value !== undefined && !(Number.isInteger(value) && value >= 1 && value <= MAX_SEED)
      ? { value: undefined, reason: 'seed_unreproducible' }
      : undefined,
  // Seed is stored globally (bare key), not per family.
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
 * images/video are stored per WORKFLOW, not per
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
  /** Present when the ecosystem takes a custom width × height; the picker offers "Custom". */
  custom?: CustomDimensionLimits;
}

export const aspectRatioDef = cachedFactory(function aspectRatioDef(opts: {
  options: AspectRatioOption[];
  default?: string;
  priorityOptions?: string[];
  /** Accept `{ value: 'custom', width, height }`, fitted inside these limits. */
  custom?: CustomDimensionLimits;
}) {
  const options = opts.options;
  const custom = opts.custom;
  // Custom sizes go through the same fitting on every path — the client's pick, a
  // remix, and the server's re-parse — so nothing outside the limits is ever sent.
  const fitCustom = (val: { width?: number; height?: number }): AspectRatioValue | undefined => {
    if (!custom || !val.width || !val.height) return undefined;
    const fit = fitCustomDimensions({ width: val.width, height: val.height }, custom);
    return fit && { value: CUSTOM_ASPECT_RATIO, ...fit };
  };
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
        if (value === CUSTOM_ASPECT_RATIO && typeof val === 'object') {
          const fitted = fitCustom(val);
          if (fitted) return fitted;
        }
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
    // Output checks SHAPE, not membership, so an out-of-set ratio would validate
    // and be submitted rather than blocked — the quiet half of the same problem
    // the other defs' `correct` hooks solve loudly.
    //
    // Membership is by label AND size: Flux Ultra's 16:9 is 2752×1536 and
    // Standard's is 1344×768, and the modes share one aspectRatio, so a label-only
    // check left Ultra's size in state after a switch. (The server re-parses through
    // `input` and generated the right size; only the client state was wrong.)
    correct: (value) => {
      if (value.value === CUSTOM_ASPECT_RATIO) {
        const fitted = fitCustom(value);
        if (!fitted)
          return {
            value: toValue(findClosestAspectRatio(value, options)),
            reason: 'ratio_unavailable',
          };
        return fitted.width === value.width && fitted.height === value.height
          ? undefined
          : { value: fitted, reason: 'dimensions_fitted' };
      }
      const exact = options.find((o) => o.value === value.value);
      if (!exact)
        return {
          value: toValue(findClosestAspectRatio(value, options)),
          reason: 'ratio_unavailable',
        };
      if (exact.width !== value.width || exact.height !== value.height)
        return { value: toValue(exact), reason: 'ratio_resized' };
      return undefined;
    },
    meta: {
      options,
      ...(opts.priorityOptions ? { priorityOptions: opts.priorityOptions } : {}),
      ...(custom ? { custom } : {}),
    },
  } satisfies FieldDef<AspectRatioValue, AspectRatioMeta>;
});

// --- text (prompt / negativePrompt) -------------------------------------------

export interface TextMeta {
  required: boolean;
  targetKey: string;
  /**
   * The editor's slice of `snippets.targets`; `undefined` when snippets are
   * off (no wildcards flag) or the editor is a plain node — presence is the
   * feature flag the React editor keys off.
   */
  snippets?: SnippetsValue['targets'][string];
  triggerWords: string[];
  placeholder?: string;
  info?: string;
}

/**
 * Hooks for a field declared INLINE in a graph rather than built from a def.
 *
 * The rule is the same one `enumDef` and `sliderDef` already apply, and the reason strings
 * match theirs so a consumer of the resolution notes cannot tell the two apart. They exist
 * because ~20 family fields declare their own schemas (a per-version option set, a meta
 * shape the def does not carry) and so never got the def-level hook — a trusted write past
 * the bound then reached `validate()` and refused, which the footer renders as a Generate
 * button that does nothing.
 *
 * 🔴 `optionFallback` and `clampCorrect` are `correct` hooks, so they ALSO run on the server
 * parse. Only attach them where `input` already rejects or normalises the same value — a
 * permissive `input` needs the `coerce` pair instead, or a 400 becomes a silent
 * normalise-and-bill. `no-uncorrected-constrained-def.test.ts` pins which is which.
 */
export const optionFallback =
  <T>(options: readonly T[], fallback: T) =>
  (value: T) => {
    if (options.includes(value)) return undefined;

    // 🔴 Try a RESPELLING before dropping to the default. Sibling families spell the same
    // option differently — Flux3's resolutions are `1k`/`2k`/`4k` while Ming's and Qwen 2.1's
    // are `1K`/`2K` — so an INGESTION between them (remix/replay/preset, which writes the
    // value onto the already-active target) hit the fallback and silently moved the user from
    // the 2K they picked to 1k, on a family that has 2k. Not reachable by switching the
    // ecosystem picker: a scoped field does not carry, so the target just takes its default.
    // Mapping the case keeps their choice,
    // and since nothing about the output changes there is nothing to tell them: this reason is
    // deliberately absent from `FieldCorrectionNote`'s messages.
    if (typeof value === 'string') {
      const respelled = options.find(
        (option) => typeof option === 'string' && option.toLowerCase() === value.toLowerCase()
      );
      if (respelled !== undefined) return { value: respelled, reason: 'option_respelled' };
    }

    return { value: fallback, reason: 'option_unavailable' };
  };

/** Clamp into [min, max]; a non-finite value falls back (NaN would propagate and refuse). */
export const clampCorrect =
  ({ min, max, fallback }: { min: number; max: number; fallback: number }) =>
  (value: number) => {
    const next = Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
    return next === value ? undefined : { value: next, reason: 'out_of_range' };
  };

/** The `coerce` form of {@link clampCorrect}, for a field whose `input` carries no bound. */
export const clampCoerce =
  ({ min, max, fallback }: { min: number; max: number; fallback: number }) =>
  (raw: unknown) => {
    if (typeof raw !== 'number') return raw as number;
    return Number.isFinite(raw) ? Math.min(Math.max(raw, min), max) : fallback;
  };

/** The `coerce` form of `textDef`'s truncation, for an inline string field. */
export const truncateCoerce = (maxLength: number) => (raw: unknown) =>
  typeof raw === 'string' && raw.trim().length > maxLength
    ? raw.trim().slice(0, maxLength)
    : (raw as string);
/**
 * Output trims and caps length. Requiredness is per-pass
 * (prompt is required only when no images are attached), so it lives at the
 * call site as an output spread — this definition carries the unconditional part.
 */
// Not the lib's `textOf`: trims on output and words its messages by field name.
export const textDef = cachedFactory(function textDef(
  name: string,
  maxLength: number = MAX_PROMPT_LENGTH
) {
  return {
    input: z.string().optional(),
    output: z.string().trim().max(maxLength, `${name} is too long`),
    default: '',
    // 🔴 `coerce`, NOT `correct` — and the difference is a billed path. Same trusted-write
    // hole as `imagesDef` (an over-length prompt reaches `validate()` and refuses, so a
    // remix onto a tighter-capped family blocks the submit), but unlike the other
    // two defs this one's `input` carries NO length bound. A `correct` would therefore be
    // the first thing to see an over-length value on the SERVER parse too, turning a 400
    // into a silent truncate-and-bill. `coerce` runs for trusted `set()` writes only, so
    // ingestion self-heals and the parse still refuses. Verified both ways in
    // `def-constraint-correction.test.ts`.
    //
    // Trimmed length, matching `output`'s `.trim().max()`: measuring the raw string would
    // truncate a value that only exceeds the cap through leading whitespace.
    coerce: (raw) =>
      typeof raw === 'string' && raw.trim().length > maxLength
        ? raw.trim().slice(0, maxLength)
        : (raw as string),
  } satisfies FieldDef<string>;
});

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
  // Raw orchestrator-blob AIR resources (training epochs without a ModelVersion row) —
  // negative id + air + workflowId. This schema serializes the whatIf/generate payloads,
  // so dropping these makes the server's StrictAirMap 400 on the synthetic id.
  air: z.string().optional(),
  workflowId: z.string().optional(),
  name: z.string().optional(),
});
export type ResourceData = z.infer<typeof resourceSchema>;

export const resourceInputSchema = z.union([
  z.number().transform((id) => ({ id })),
  z.looseObject({ id: z.number() }),
]);

/** One row of the resource picker's filter: a model type + the base models it accepts. */
export interface ResourceSelectOption {
  type: ModelType;
  baseModels: string[];
  partialSupport: string[];
}

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

/** Default addon types. */
const DEFAULT_RESOURCE_TYPES = ['TextualInversion', 'LORA', 'LoCon', 'DoRA'] as ModelType[];

export interface ResourcesMeta {
  options: { canGenerate: boolean; resources: ResourceSelectOption[]; excludeIds: number[] };
  limit: number;
}

/**
 * Lenient array input, strict capped output, the picker's type/baseModel filter in
 * meta, and the ecosystem-compatibility filter — a `correct`, so an incompatible
 * resource is dropped DURING the parse and leaves a note.
 */
export const resourcesDef = cachedFactory(function resourcesDef(opts: {
  ecosystem: string;
  limit: number;
  resourceTypes?: ModelType[];
  /**
   * Filtering cross-ecosystem resources is the default; ernie is the one family
   * that keeps them.
   */
  filterIncompatible?: boolean;
}) {
  const { ecosystem, limit } = opts;
  const resourceTypes = opts.resourceTypes ?? DEFAULT_RESOURCE_TYPES;
  const selectOptions = getResourceSelectOptions(ecosystem, resourceTypes);
  const ecosystemData = ecosystemByKey.get(ecosystem);
  return {
    input: resourceInputSchema.array().optional(),
    // .optional() on the OUTPUT schema; the state itself is never
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
});

/**
 * A single optional resource with no default; an incompatible VAE is cleared by a
 * `correct`, during the parse.
 */
export const vaeDef = cachedFactory(function vaeDef(opts: { ecosystem: string }) {
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
});

export interface CheckpointMeta {
  options: { canGenerate: boolean; resources: ResourceSelectOption[]; excludeIds: number[] };
  modelLocked: boolean;
  versions: VersionGroup | undefined;
  defaultModelId: number | undefined;
}

/**
 * The checkpoint field, minus the selector-switching behaviour (that is a rule at the
 * family level). The locked/ecosystem substitutions are `correct` policies declared at
 * the call site, so each note carries its reason.
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

/** Min comes from the required slots, max from the slot count. */
export const imagesDef = cachedFactory(function imagesDef(config: {
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
    // 🔴 THE CAP HAS TO BE HERE AS WELL AS IN `input`. Ingestion writes through a trusted
    // `set()`, which skips the input transform — so an over-cap array reaches `validate()`
    // and refuses, blocking any remix (or image append) carrying more images than the
    // target ecosystem accepts. Unlike most corrected fields the images input DOES render
    // its own error, so the user can see and fix this one — correcting it is about not
    // making them, since the extra images are the source's, not a choice they made. Only
    // MAX corrects; too FEW is a real error the user has to resolve.
    // A trusted write also skips the string → `{ url }` mapping, and the images input reads
    // `.url` off every entry, so a bare URL from a remix crashes the page instead of loading.
    correct: (value) => {
      const entries = value as (ImageEntry | string)[] | undefined;
      if (entries?.some((item) => typeof item === 'string')) {
        const objects = entries.map((item) => (typeof item === 'string' ? { url: item } : item));
        return { value: objects.slice(0, max) as ImageEntry[], reason: 'url_string' };
      }
      return (value?.length ?? 0) > max
        ? { value: value.slice(0, max), reason: 'over_cap' }
        : undefined;
    },
    meta: {
      min,
      max,
      slots: config.slots,
      warnOnMissingAiMetadata: config.warnOnMissingAiMetadata,
      aspectRatios: config.aspectRatios,
    },
  } satisfies FieldDef<ImageEntry[], ImagesMeta>;
});

const videoMetadataSchema = z.object({
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  duration: z.number(),
});
export type VideoValue = { url: string; metadata?: z.infer<typeof videoMetadataSchema> };

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

/** Default sampler presets. */
export const defaultSamplerPresets = [
  { label: 'Fast', value: 'Euler a' },
  { label: 'Popular', value: 'DPM++ 2M Karras' },
];

// --- quantity -------------------------------------------------------------------

/** Min and default both equal the step. */
export const quantityDef = cachedFactory(function quantityDef(opts: {
  max: number;
  step?: number;
}) {
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
    // `max` comes from the user's own `limits.maxQuantity`, so this fires whenever a
    // trusted write carries a quantity from a wider entitlement than the current one.
    correct: (value) => {
      const snapped = snapToStep(value, step, min, max);
      return snapped === value ? undefined : { value: snapped, reason: 'out_of_range' };
    },
    meta: { min, max, step },
  } satisfies FieldDef<number, NumberMeta>;
});

/**
 * A bounded number that REFUSES out-of-range input (falls to the default with
 * the error recorded) instead of snapping — the hand-written-def policy
 * (grok/kling durations, ltx frame count, wan shift), distinct from
 * `sliderDef`, which clamps.
 */
export const refusingRangeDef = cachedFactory(function refusingRangeDef(opts: {
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
    // The REFUSAL this is named for is the parse boundary, and it stays: `input`'s
    // min/max are refinements, so an out-of-range value from a caller still fails there.
    // This only covers the trusted path, where a video remix routinely carries another
    // family's duration (Grok 6–15 vs Kling V3 5–15 — a 5s Kling clip remixed onto Grok
    // refused at `validate()`).
    correct: (value) =>
      value < min || value > max
        ? { value: snapToStep(value, step, min, max), reason: 'out_of_range' }
        : undefined,
    meta: { min, max, step },
  } satisfies FieldDef<number, NumberMeta>;
});

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
 * Lenient staged entries on input (missing image
 * allowed, forced-preprocessed modes applied), image-less entries filtered
 * before the strict output pass; category-grouped picker options in meta.
 */
export const controlNetsDef = cachedFactory(function controlNetsDef(opts: {
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
    // [] when nothing is staged, not undefined — the wire shape callers expect
    default: [],
    // Staged nets survive an ecosystem switch (see `scope` below), so the limit they
    // came from is not the limit they end up under: two nets staged on a 4-limit family
    // then switched to a 1-limit one refused at `validate()`.
    correct: (value) =>
      (value?.length ?? 0) > limit
        ? { value: value!.slice(0, limit), reason: 'over_cap' }
        : undefined,
    // controlNets is stored globally (bare key) so staged nets survive
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
});

// --- controlVideo ---------------------------------------------------------------

const controlVideoValueSchema = z.object({
  url: z.string(),
  metadata: z
    .object({ fps: z.number(), width: z.number(), height: z.number(), duration: z.number() })
    .optional(),
});

const controlVideoInputSchema = z.object({
  preprocessor: z.string(),
  mode: z.enum(controlNetModes).optional(),
  video: z.union([z.string(), controlVideoValueSchema]).optional(),
  strength: z.coerce.number().min(0).max(1).optional(),
  startPercent: z.coerce.number().min(0).max(1).optional(),
  endPercent: z.coerce.number().min(0).max(1).optional(),
});

const controlVideoOutputSchema = z.object({
  preprocessor: z.enum(
    videoControlNetPreprocessors as unknown as [
      VideoControlNetPreprocessorKey,
      ...VideoControlNetPreprocessorKey[]
    ]
  ),
  mode: z.enum(controlNetModes),
  video: controlVideoValueSchema,
  strength: z.number().min(0).max(1),
  startPercent: z.number().min(0).max(1),
  endPercent: z.number().min(0).max(1),
});
export type ControlVideoValue = z.infer<typeof controlVideoOutputSchema>;

export interface ControlVideoMeta {
  options: ControlNetOption[];
  groups: { category: ControlNetCategory; label: string; options: ControlNetOption[] }[];
  strength: { min: number; max: number; default: number; step: number };
  percent: { min: number; max: number; step: number };
}

export const controlVideoDef = cachedFactory(function controlVideoDef(opts: {
  preprocessors: readonly VideoControlNetPreprocessorKey[];
}) {
  const seen = new Set<VideoControlNetPreprocessorKey>();
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
    input: controlVideoInputSchema
      .refine((e) => allowedKeys.has(e.preprocessor), {
        message: 'Unsupported ControlNet preprocessor for this model',
        path: ['preprocessor'],
      })
      .optional()
      .transform((entry) => {
        if (!entry) return undefined;
        const video = typeof entry.video === 'string' ? { url: entry.video } : entry.video;
        const requiresPreprocessed =
          controlNetPreprocessors[entry.preprocessor as ControlNetPreprocessorKey]
            ?.requiresPreprocessedImage ?? false;
        return {
          preprocessor: entry.preprocessor,
          mode: requiresPreprocessed ? 'preprocessed' : entry.mode ?? 'auto',
          video: video?.url ? video : undefined,
          strength: entry.strength ?? 1,
          startPercent: entry.startPercent ?? 0,
          endPercent: entry.endPercent ?? 1,
        };
      }),
    output: z
      .unknown()
      .optional()
      .transform((entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        !!(entry as { video?: { url?: string } }).video?.url
          ? entry
          : undefined
      )
      .pipe(controlVideoOutputSchema.optional()),
    default: undefined,
    // CLEARED, not remapped — there is no honest nearest preprocessor to pick. Stored
    // globally (see `scope`), so a control video staged on one family survives onto
    // another whose preprocessor list does not include it; `input`'s own `.refine`
    // covers the parse path, this covers the trusted one.
    correct: (value) =>
      value && !allowedKeys.has(value.preprocessor)
        ? { value: undefined, reason: 'preprocessor_unavailable' }
        : undefined,
    scope: rootScope(),
    meta: {
      options,
      groups,
      strength: { min: 0, max: 1, default: 1, step: 0.05 },
      percent: { min: 0, max: 1, step: 0.05 },
    },
  } satisfies FieldDef<ControlVideoValue | undefined, ControlVideoMeta>;
});

/** Low/Balanced/High guidance presets — shared by chroma, flux, flux2 and pony-v7. */
export const guidancePresetsLowBalHigh = [
  { label: 'Low', value: 2 },
  { label: 'Balanced', value: 3.5 },
  { label: 'High', value: 7 },
];

/** All nine SDXL buckets: 3:2 / 1:1 / 2:3 in the row, the rest behind More. */
export const SDXL_FULL_AR = aspectRatioDef({
  options: sdxlFullAspectRatioBuckets,
  priorityOptions: sdxlFullPriorityAspectRatios,
  default: '1:1',
  custom: sdxlCustomDimensionLimits,
});

/** SDXL_FULL_AR for models documented to ~2 MP: the size warning moves up to 2 MP. */
export const SDXL_FULL_AR_2MP = aspectRatioDef({
  options: sdxlFullAspectRatioBuckets,
  priorityOptions: sdxlFullPriorityAspectRatios,
  default: '1:1',
  custom: twoMegapixelCustomDimensionLimits,
});

/** SDXL_FULL_AR for models documented to ~4 MP: custom sizes up to the 4 MP ceiling. */
export const SDXL_FULL_AR_4MP = aspectRatioDef({
  options: sdxlFullAspectRatioBuckets,
  priorityOptions: sdxlFullPriorityAspectRatios,
  default: '1:1',
  custom: fourMegapixelCustomDimensionLimits,
});

/** SDXL_FULL_AR minus the buckets over Flux.1 Pro's 1440 side limit. */
export const FLUX1_PRO_AR = aspectRatioDef({
  options: flux1ProAspectRatioBuckets,
  priorityOptions: sdxlFullPriorityAspectRatios,
  default: '1:1',
  custom: flux1ProCustomDimensionLimits,
});
