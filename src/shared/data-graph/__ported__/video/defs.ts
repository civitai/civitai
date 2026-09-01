import { z } from 'zod';
import type { FieldDef } from 'form-graph';
import { MAX_SEED } from '~/shared/constants/generation.constants';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { MAX_PROMPT_LENGTH, type AspectRatioOption } from '~/shared/data-graph/generation/common';

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

/**
 * Copied from common.ts (module-local there, so not importable). Pure
 * arithmetic, pinned by the differential suite.
 */
function snapToStep(val: number, step: number, min: number, max: number): number {
  const precision = Math.max(0, -Math.floor(Math.log10(step)));
  const snapped = Math.round(val / step) * step;
  const rounded = Number(snapped.toFixed(precision));
  return Math.min(Math.max(rounded, min), max);
}

// --- sliders / enums / seed ---------------------------------------------------

export interface NumberMeta {
  min: number;
  max: number;
  step: number;
  presets?: { label: string; value: number }[];
}

/** common.ts `sliderNode` */
export function sliderDef(opts: {
  min: number;
  max: number;
  step?: number;
  default?: number;
  presets?: { label: string; value: number }[];
}): FieldDef<number, NumberMeta> {
  const { min, max, step = 1 } = opts;
  return {
    input: z.coerce
      .number()
      .optional()
      .transform((val) => (val === undefined ? undefined : snapToStep(val, step, min, max))),
    output: z.number().min(min).max(max),
    default: opts.default ?? min,
    meta: { min, max, step, presets: opts.presets },
  };
}

export interface EnumMeta<T extends string | number> {
  options: readonly { label: string; value: T }[];
}

/** common.ts `enumNode` — coerces, then refuses values outside the option set. */
export function enumDef<const T extends string | number>(opts: {
  options: readonly { label: string; value: T }[];
  default?: T;
}): FieldDef<T, EnumMeta<T>> {
  const values = opts.options.map((o) => o.value);
  const isNumeric = typeof values[0] === 'number';
  const base = (isNumeric ? z.coerce.number() : z.coerce.string()) as z.ZodType<unknown>;
  const schema = base.refine((v) => values.includes(v as T)) as unknown as z.ZodType<T>;
  return {
    input: schema.optional(),
    output: schema,
    default: opts.default ?? (values[0] as T),
    meta: { options: opts.options },
  };
}

/** common.ts `seedNode` */
export const SEED: FieldDef<number | undefined> = {
  input: z
    .union([z.null(), z.undefined(), z.coerce.number().int().min(1).max(MAX_SEED)])
    .optional()
    .transform((val) => (val === null ? undefined : val)),
  output: z.number().int().min(1).max(MAX_SEED).optional(),
  default: undefined,
};

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
}): FieldDef<AspectRatioValue, AspectRatioMeta> {
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
    meta: { options },
  };
}

// --- text (prompt / negativePrompt) -------------------------------------------

export interface TextMeta {
  required: boolean;
  targetKey: string;
  triggerWords: string[];
}

/**
 * common.ts `textNode`: output trims and caps length. Requiredness is per-pass
 * (prompt is required only when no images are attached), so it lives at the
 * call site as an output spread — this definition carries the unconditional part.
 */
export function textDef(name: string, maxLength = MAX_PROMPT_LENGTH): FieldDef<string> {
  return {
    input: z.string().optional(),
    output: z.string().trim().max(maxLength, `${name} is too long`),
    default: '',
  };
}

// --- snippets ------------------------------------------------------------------

const snippetReferenceSchema = z.object({
  categoryId: z.number().int().positive(),
  in: z.array(z.number().int().positive()).default([]),
  ex: z.array(z.number().int().positive()).default([]),
});

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

export interface ResourcesMeta {
  limit: number;
}

/** common.ts `resourcesNode`: lenient array input, strict capped output. */
export function resourcesDef(limit: number): FieldDef<ResourceData[], ResourcesMeta> {
  return {
    input: resourceInputSchema.array().optional() as unknown as z.ZodType<
      ResourceData[] | undefined
    >,
    output: resourceSchema
      .array()
      .max(limit, 'You have exceeded the maximum number of allowed resources')
      .optional() as unknown as z.ZodType<ResourceData[]>,
    default: [],
    meta: { limit },
  };
}

export interface CheckpointMeta {
  modelLocked: boolean;
  versions: unknown;
  defaultModelId: number | undefined;
  excludeIds: number[];
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
  output: resourceSchema.optional() as unknown as z.ZodType<ResourceData | undefined>,
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
}): FieldDef<ImageEntry[], ImagesMeta> {
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
      ) as unknown as z.ZodType<ImageEntry[] | undefined>,
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
  };
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
  ) as unknown as z.ZodType<VideoValue>,
  default: undefined,
};

export const boolDef = (dflt: boolean): FieldDef<boolean> => ({
  input: z.boolean().optional(),
  output: z.boolean(),
  default: dflt,
});
