import { z } from 'zod';
import type { FieldDef } from 'form-graph';

/**
 * Domain-agnostic form-graph definition builders, shared by every graph under
 * `src/shared/form-graph/` (generation today, training next). Anything tied
 * to a specific domain — seeds, resources, checkpoints, prompts — lives in
 * that graph's own `defs.ts`.
 */

/** Snap to the nearest step, clamped — mirrors the UI slider's behaviour. */
export function snapToStep(val: number, step: number, min: number, max: number): number {
  const precision = Math.max(0, -Math.floor(Math.log10(step)));
  const snapped = Math.round(val / step) * step;
  const rounded = Number(snapped.toFixed(precision));
  return Math.min(Math.max(rounded, min), max);
}

export interface NumberMeta {
  min: number;
  max: number;
  step: number;
  presets?: { label: string; value: number }[];
}

/** A numeric slider: lenient input snaps into range, output enforces it. */
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

/** A closed option set: coerces, then REFUSES values outside the options. */
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

export interface SelectMeta {
  options: { label: string; value: string }[];
  presets?: { label: string; value: string }[];
}

/** A string select: unlike enumDef, an out-of-set input FALLS BACK to the default. */
export function selectDef(opts: {
  options: readonly string[];
  default?: string;
  presets?: { label: string; value: string }[];
}): FieldDef<string, SelectMeta> {
  const { options } = opts;
  const resolvedDefault =
    opts.default && options.includes(opts.default) ? opts.default : options[0]!;
  return {
    input: z
      .string()
      .optional()
      .transform((val) => {
        if (!val) return undefined;
        if (options.includes(val)) return val;
        return resolvedDefault;
      }),
    output: z.enum(options as [string, ...string[]]),
    default: resolvedDefault,
    meta: { options: options.map((s) => ({ label: s, value: s })), presets: opts.presets },
  };
}

export const boolDef = (dflt: boolean): FieldDef<boolean> => ({
  input: z.boolean().optional(),
  output: z.boolean(),
  default: dflt,
});
