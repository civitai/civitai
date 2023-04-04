import { z } from 'zod';
import { parseNumericString, parseNumericStringArray } from '~/utils/query-string-helpers';

/** Converts a string to a number */
export function numericString() {
  return z.preprocess((value) => parseNumericString(value), z.number());
}

/** Converts an array of strings to an array of numbers */
export function numericStringArray() {
  return z.preprocess((value) => parseNumericStringArray(value), z.number().array());
}

/** Converts a comma delimited string to an array of strings */
export function stringArray() {
  return z.preprocess((value) => {
    const str = String(value);
    return str.split(',');
  }, z.array(z.string()));
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
