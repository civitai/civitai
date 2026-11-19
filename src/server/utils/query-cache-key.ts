import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { toJson } from '~/utils/json-helpers';

/**
 * The statement segment of a `queryCache` / `queryCacheRaw` redis key: SHA-256 of the statement's
 * text and bound values. Callers bind viewer ids into the statement and rely on the key to keep
 * one viewer's rows from another, so it has to be collision-resistant; `hashify` is 32 bits.
 *
 * Its own module so tests that mock `cache-helpers` derive keys with the real function.
 */
export function queryCacheKeyHash(query: Prisma.Sql) {
  // Each value carries its type: JSON alone writes 1n and '1n', or a Date and its ISO string, alike.
  const values = query.values.map((v) => [v instanceof Date ? 'date' : typeof v, v]);
  return createHash('sha256')
    .update(toJson({ strings: query.strings, values }))
    .digest('base64url');
}

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
    case 'object': {
      // A Map, Set or class instance would hash by its own keys, so every one alike.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new Error(
          `cacheItKeyHash: cannot key on a ${proto?.constructor?.name ?? 'non-plain'} object`
        );
      return [
        'object',
        Object.keys(value as object)
          .sort()
          .map((k) => [k, tagged((value as Record<string, unknown>)[k])]),
      ];
    }
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
