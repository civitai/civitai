import { z } from 'zod';
import { parseNumericString, parseNumericStringArray } from '~/utils/query-string-helpers';

export function numericString() {
  return z.preprocess((value) => parseNumericString(value), z.number());
}

export function numericStringArray() {
  return z.preprocess((value) => parseNumericStringArray(value), z.number().array());
}

export function stringArray() {
  return z.preprocess((value) => {
    const str = String(value);
    return str.split(',');
  }, z.array(z.string()));
}

export function booleanString() {
  return z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value === 'true'
        : typeof value === 'number'
        ? value === 1
        : undefined,
    z.boolean()
  );
}
