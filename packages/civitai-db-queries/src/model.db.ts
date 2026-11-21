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
 * review) and their Favorite / Notify / Mute engagements, with each model's owner and the time of
 * the touch. Likes, Favorites and Notifies are each capped at `limit`. Notify is the type heavy users
 * pile up, so it reads newest first, served by the partial notify (userId, createdAt) index. Likes and
 * Favorites have no such index, and ordering them by time sorts every row a user has before the limit
 * applies, so past the cap they keep an arbitrary `limit`. A liked model can come back once per
 * review; the caller keeps its latest touch. Mutes are not capped, so one cannot fall out behind
 * newer favourites.
 */
export async function listModelStake(db: Kysely<DB>, input: { userId: number; limit: number }) {
  const [likes, favorites, notifies, mutes] = await Promise.all([
    db
      .selectFrom('ResourceReview as rr')
      .innerJoin('Model as m', 'm.id', 'rr.modelId')
      .select(['rr.modelId', 'm.userId', 'rr.createdAt as touchedAt'])
      .where('rr.userId', '=', input.userId)
      .where('rr.recommended', '=', true)
      .where('rr.exclude', '=', false)
      .where('rr.tosViolation', '=', false)
      .limit(input.limit)
      .execute(),
    db
      .selectFrom('ModelEngagement as e')
      .innerJoin('Model as m', 'm.id', 'e.modelId')
      .select(['e.modelId', 'm.userId', 'e.type', 'e.createdAt as touchedAt'])
      .where('e.userId', '=', input.userId)
      .where('e.type', '=', 'Favorite')
      .limit(input.limit)
      .execute(),
    db
      .selectFrom('ModelEngagement as e')
      .innerJoin('Model as m', 'm.id', 'e.modelId')
      .select(['e.modelId', 'm.userId', 'e.type', 'e.createdAt as touchedAt'])
      .where('e.userId', '=', input.userId)
      .where('e.type', '=', 'Notify')
      .orderBy('e.createdAt', 'desc')
      .limit(input.limit)
      .execute(),
    db
      .selectFrom('ModelEngagement as e')
      .innerJoin('Model as m', 'm.id', 'e.modelId')
      .select(['e.modelId', 'm.userId', 'e.type', 'e.createdAt as touchedAt'])
      .where('e.userId', '=', input.userId)
      .where('e.type', '=', 'Mute')
      .execute(),
  ]);
  return { likes, engagements: [...favorites, ...notifies, ...mutes] };
}

/**
 * Every model with a version that counts as new since `since`: Published, Public or EarlyAccess
 * (a paid version keeps EarlyAccess for good), and not a paid-gate re-date: a version whose
 * publishedAt moved more than a day past its first publish is the same version, not a new one. The
 * re-date clause mirrors the one in the hot_version_score() SQL function (#9928); change both together.
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
