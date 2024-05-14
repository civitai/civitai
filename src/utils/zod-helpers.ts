import { z, ZodArray, ZodNumber } from 'zod';
import { sanitizeHtml, santizeHtmlOptions } from '~/utils/html-helpers';
import { parseNumericString, parseNumericStringArray } from '~/utils/query-string-helpers';

/** Converts a string to a number */
export function numericString<I extends ZodNumber>(schema?: I) {
  return z.preprocess((value) => parseNumericString(value), schema ?? z.number());
}

/** Converts an array of strings to an array of numbers */
export function numericStringArray<I extends ZodArray<ZodNumber>>(schema?: I) {
  return z.preprocess((value) => parseNumericStringArray(value), schema ?? z.number().array());
}

export function stringArray<I extends ZodArray<ZodNumber>>(schema?: I) {
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
  }, z.record(z.string()));
}

export function stringToArray(value: unknown) {
  if (!Array.isArray(value) && typeof value === 'string')
    return value.split(',').map((x) => x.trim());
  return ((value ?? []) as unknown[]).map(String);
}

/** Converts a comma delimited string to an array of strings */
export function commaDelimitedStringArray() {
  return z.preprocess(stringToArray, z.array(z.string()));
}

// include=tags,category
export function commaDelimitedEnumArray<T extends [string, ...string[]]>(zodEnum: z.ZodEnum<T>) {
  return z.preprocess(stringToArray, z.array(zodEnum));
}

/** Converts a comma delimited string to an array of numbers */
export function commaDelimitedNumberArray(options?: { message?: string }) {
  return z.preprocess((val) => stringToArray(val).map(parseNumericString), z.array(z.number()));
}

// TODO - replace all with z.coerce.date()
export function stringDate() {
  return z.preprocess((value) => {
    if (!value) return;
    if (typeof value === 'string') return new Date(value);
    if (typeof value === 'number') return new Date(value);
  }, z.date().optional());
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
  return z.preprocess((val) => {
    if (!val) return;
    const str = String(val);
    const result = sanitizeHtml(str, options);
    if (result.length === 0) return null;

    return result;
  }, z.string().nullish());
}

export function zodEnumFromObjKeys<K extends string>(
  obj: Record<K, unknown>
): z.ZodEnum<[K, ...K[]]> {
  const [firstKey, ...otherKeys] = Object.keys(obj) as K[];
  return z.enum([firstKey, ...otherKeys]);
}
