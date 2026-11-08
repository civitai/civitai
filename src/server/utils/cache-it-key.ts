import { createHash } from 'node:crypto';

/**
 * The hash segment of a `cacheIt` redis key: SHA-256 over the procedure's input and `varyBy`
 * values. One key serves every caller whose values hash alike, so it has to be
 * collision-resistant; `hashifyObject` is 32 bits.
 */
export function cacheItKeyHash(obj: Record<string, unknown>) {
  return createHash('sha256')
    .update(JSON.stringify(tagged(obj)))
    .digest('base64url');
}

// Object keys sorted, so the same values in another order share a key. Each value carries its
// type: JSON alone writes 1n and '1n', a Date and its ISO string, or undefined and null, alike.
function tagged(value: unknown): unknown {
  if (value === null) return ['null'];
  if (value instanceof Date) return ['date', String(value.getTime())];
  if (Array.isArray(value)) return ['array', value.map(tagged)];
  switch (typeof value) {
    case 'object':
      return [
        'object',
        Object.keys(value as object)
          .sort()
          .map((k) => [k, tagged((value as Record<string, unknown>)[k])]),
      ];
    case 'number':
    case 'bigint':
    case 'symbol':
    case 'function':
      return [typeof value, String(value)];
    case 'undefined':
      return ['undefined'];
    default:
      return [typeof value, value];
  }
}
