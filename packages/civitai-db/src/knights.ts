import { sql, type ExpressionBuilder, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import * as shared from '@civitai/shared';

// tsx loads CommonJS-scoped workspace packages as one `default` object when an ES module imports them.
const { NsfwLevel } = (shared as { default?: typeof shared }).default ?? shared;

export const REFERENCE_POOL = { trials: 'trials', hiddenCheck: 'hiddenCheck' } as const;
export const REFERENCE_SOURCE = {
  core: 'core',
  harvested: 'harvested',
  agreement: 'agreement',
} as const;
export const REFERENCE_STATUS = {
  active: 'active',
  pending: 'pending',
  retired: 'retired',
} as const;

type Joined = DB & { img: DB['Image']; p: DB['Post'] };

/**
 * Images the public feeds would show: a published post, a rated image with no block marker and
 * no review hold. Expects `Image as img` joined to `Post as p`.
 */
export const servableImage = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([
    eb('img.type', '=', 'image'),
    eb('img.nsfwLevel', 'not in', [0, NsfwLevel.Blocked]),
    eb('img.ingestion', '!=', 'Blocked'),
    eb('img.blockedFor', 'is', null),
    eb('img.needsReview', 'is', null),
    eb('img.acceptableMinor', '=', false),
    eb('p.publishedAt', 'is not', null),
    eb('p.publishedAt', '<', sql<Date>`(now() AT TIME ZONE 'utc')`),
  ]);

/** Settles every still-pending vote on an item against the answer it was finally decided as. */
export async function gradeKnightsVotes(
  db: Kysely<DB> | Transaction<DB>,
  itemId: number,
  correctAnswer: string
) {
  await db
    .updateTable('KnightsVote')
    .set({
      verdict: sql<string>`CASE WHEN "answer" = ${correctAnswer} THEN 'correct' ELSE 'failed' END`,
    })
    .where('itemId', '=', itemId)
    .where('verdict', '=', 'pending')
    .execute();
}
