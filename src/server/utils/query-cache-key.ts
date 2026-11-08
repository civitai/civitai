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
