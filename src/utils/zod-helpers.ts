import * as z from 'zod/v4';
import type { santizeHtmlOptions } from '~/utils/html-helpers';
import { sanitizeHtml } from '~/utils/html-helpers';
import { parseNumericString, parseNumericStringArray } from '~/utils/query-string-helpers';

/** Converts a string to a number */
export function numericString<I extends z.ZodNumber>(schema?: I) {
  return z.preprocess((value) => parseNumericString(value), schema ?? z.number());
}

/** Converts an array of strings to an array of numbers */
export function numericStringArray<I extends z.ZodArray<z.ZodNumber>>(schema?: I) {
  return z.preprocess((value) => parseNumericStringArray(value), schema ?? z.number().array());
}

export function stringArray<I extends z.ZodArray<any>>(schema?: I) {
  return z.preprocess(
    (value) => (!Array.isArray(value) ? [value] : value),
    schema ?? z.string().array()
  );
}

/** Converts a comma delimited object (ex key:value,key 2:another value) */
export function commaDelimitedStringObject() {
  return z.preprocess((value) => {
    if (typeof value === 'string') {
      const obj: Record<string, string> = {};
      value.split(',').forEach((x) => {
        const [key, val] = x.split(':');
        obj[key] = val ?? key;
      });
      return obj;
    }
    return value;
  }, z.record(z.string(), z.string()));
}

export function stringToArray<T extends string = string>(value: unknown): T[] {
  if (!Array.isArray(value) && typeof value === 'string')
    return value.split(',').map((x) => x.trim()) as T[];
  return ((value ?? []) as unknown[]).map(String) as T[];
}

/** Converts a comma delimited string to an array of strings */
export function commaDelimitedStringArray() {
  return z.preprocess(stringToArray, z.array(z.string()));
}

// include=tags,category
export function commaDelimitedEnumArray<T extends string>(zodEnum: T[]) {
  return z
    .enum(zodEnum)
    .array()
    .or(
      z
        .string()
        .transform((str) => stringToArray<T>(str))
        .refine((arr) => arr.every((val) => zodEnum.includes(val)))
    );
}

/** Converts a comma delimited string to an array of numbers */
export function commaDelimitedNumberArray() {
  return z
    .number()
    .array()
    .or(
      z
        .string()
        .transform((str) => stringToArray(str).map(Number))
        .refine((arr) => arr.every((val) => val && !isNaN(val)))
    );
}

/** Converts the string `true` to a boolean of true and everything else to false */
export function booleanString() {
  return z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value === 'true'
        : typeof value === 'number'
        ? value === 1
        : typeof value === 'boolean'
        ? value
        : undefined,
    z.boolean()
  );
}

export function sanitizedNullableString(options: santizeHtmlOptions) {
  return z.preprocess((val, ctx) => {
    if (!val) return;

    try {
      const str = String(val);
      const result = sanitizeHtml(str, options);
      if (result.length === 0) return null;
      return result;
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: (e as any).message,
      });
    }
  }, z.string().nullish());
}

export function zodEnumFromObjKeys<K extends string>(obj: Record<K, unknown>) {
  const [firstKey, ...otherKeys] = Object.keys(obj) as K[];
  return z.enum([firstKey, ...otherKeys]);
}

export function numberEnum<Num extends number, T extends Readonly<Num[]>>(
  args: T
): z.ZodSchema<T[number]> {
  return z.custom<T[number]>((val: any) => args.includes(val));
}

export type SchemaInputOutput<T extends z.ZodType<any, any, any>> = {
  Input: z.input<T>;
  Output: z.output<T>;
};
