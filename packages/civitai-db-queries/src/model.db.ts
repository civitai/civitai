import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

/**
 * A user's engagements with a bounded set of models — the membership read behind the
 * per-visible-set engagement lookup, and one of the highest-volume statements the app issues.
 *
 * `type` is a SCALAR Postgres enum (`ModelEngagementType`), which pg reads back as plain text and
 * Kysely types as the enum union — the same string Prisma returned. It is NOT an enum ARRAY, which
 * is the shape that needs `registerEnumArrayTypeParsers` (a `SomeEnum[]` column has a dynamic oid
 * and would otherwise arrive as the raw `{a,b}` literal). Both selected columns are int4/text with
 * built-in pg parsers, so this query depends on no type-parser registration at all.
 *
 * No `orderBy`, matching the source query: the caller buckets rows by `type` into arrays it uses as
 * sets, so row order is not observable.
 */
export async function listModelEngagements(
  db: Kysely<DB>,
  input: { userId: number; modelIds: number[] }
) {
  // Kysely compiles `in ([])` to the Postgres syntax error `IN ()`; Prisma returned []. The tRPC input
  // schema bounds `modelIds` to 1..200, but this function is also reachable from server-side callers
  // that don't go through it.
  if (!input.modelIds.length) return [];
  return db
    .selectFrom('ModelEngagement')
    .select(['modelId', 'type'])
    .where('userId', '=', input.userId)
    .where('modelId', 'in', input.modelIds)
    .execute();
}
