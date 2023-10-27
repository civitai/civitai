import { z, ZodNumber, ZodArray } from 'zod';
import { parseNumericString, parseNumericStringArray } from '~/utils/query-string-helpers';
import { sanitizeHtml, santizeHtmlOptions } from '~/utils/html-helpers';
import { isNumeric } from '~/utils/number-helpers';

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

/** Converts a comma delimited string to an array of strings */
export function commaDelimitedStringArray() {
  return z.preprocess((value) => {
    if (Array.isArray(value)) return value.length ? value.map(String) : [];

    const str = String(value);
    return str.split(',');
  }, z.array(z.string()));
}

/** Converts a comma delimited string to an array of numbers */
export function commaDelimitedNumberArray(options?: { message?: string }) {
  return commaDelimitedStringArray()
    .transform((val) => parseNumericStringArray(val) ?? [])
    .refine(
      (val) => (val ? val?.every((v) => isNumeric(v)) : true),
      options?.message ?? 'Value should be a number array'
    );
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
