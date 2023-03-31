import { z } from 'zod';
import { parseNumericString, parseNumericStringArray } from '~/utils/query-string-helpers';

export function numericString() {
  return z.preprocess((value) => parseNumericString(value), z.number());
}

export function numericStringArray() {
  return z.preprocess((value) => parseNumericStringArray(value), z.number().array());
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
