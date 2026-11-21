import { type Kysely, sql } from 'kysely';
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

/**
 * A viewer's stake in models, for the personalised Hot lead: the models they liked (a thumbs-up
 * review) and their Favorite / Notify / Mute engagements, newest touch first, with each model's
 * owner. Likes and Favorite / Notify are each capped at `limit`; Mutes are not.
 */
export async function listModelStake(db: Kysely<DB>, input: { userId: number; limit: number }) {
  const [likes, engagements, mutes] = await Promise.all([
    db
      .selectFrom('ResourceReview as rr')
      .innerJoin('Model as m', 'm.id', 'rr.modelId')
      .select((eb) => ['rr.modelId', 'm.userId', eb.fn.max('rr.createdAt').as('touchedAt')])
      .where('rr.userId', '=', input.userId)
      .where('rr.recommended', '=', true)
      .where('rr.exclude', '=', false)
      .where('rr.tosViolation', '=', false)
      .groupBy(['rr.modelId', 'm.userId'])
      .orderBy('touchedAt', 'desc')
      .limit(input.limit)
      .execute(),
    db
      .selectFrom('ModelEngagement as e')
      .innerJoin('Model as m', 'm.id', 'e.modelId')
      .select(['e.modelId', 'm.userId', 'e.type', 'e.createdAt as touchedAt'])
      .where('e.userId', '=', input.userId)
      .where('e.type', 'in', ['Favorite', 'Notify'])
      .orderBy('e.createdAt', 'desc')
      .limit(input.limit)
      .execute(),
    // Uncapped: a Mute must not fall out behind newer favourites.
    db
      .selectFrom('ModelEngagement as e')
      .innerJoin('Model as m', 'm.id', 'e.modelId')
      .select(['e.modelId', 'm.userId', 'e.type', 'e.createdAt as touchedAt'])
      .where('e.userId', '=', input.userId)
      .where('e.type', '=', 'Mute')
      .execute(),
  ]);
  return { likes, engagements: [...engagements, ...mutes] };
}

/**
 * Every model with a version that counts as new since `since`: Published, Public or EarlyAccess
 * (a paid version keeps EarlyAccess for good), and not a paid-gate re-date: a version whose
 * publishedAt moved more than a day past its first publish is the same version, not a new one.
 * One row per model, its newest such version. Not per viewer: the personalised Hot lead filters
 * this list in memory.
 */
export async function listRecentlyVersionedModels(db: Kysely<DB>, input: { since: Date }) {
  return db
    .selectFrom('ModelMetric as mm')
    .innerJoin('ModelVersion as mv', 'mv.modelId', 'mm.modelId')
    .select([
      'mm.modelId',
      'mm.userId',
      'mm.hotScore',
      'mv.publishedAt as versionPublishedAt',
      'mv.nsfwLevel as versionNsfwLevel',
    ])
    .distinctOn('mm.modelId')
    .where('mm.status', '=', 'Published')
    .where('mm.lastVersionAt', '>', input.since)
    .where('mv.status', '=', 'Published')
    .where('mv.availability', 'in', ['Public', 'EarlyAccess'])
    .where('mv.publishedAt', '>', input.since)
    .where(
      sql<boolean>`mv."publishedAt" < coalesce(mv."initialPublishedAt", mv."publishedAt") + interval '1 day'`
    )
    .orderBy('mm.modelId')
    .orderBy('mv.publishedAt', 'desc')
    .execute();
}
