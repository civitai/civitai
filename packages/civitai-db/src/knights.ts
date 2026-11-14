import { sql, type ExpressionBuilder, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import * as shared from '@civitai/shared';
import { withheldCosmeticIds } from '@civitai/shared/knights-shop';

// tsx loads CommonJS-scoped workspace packages as one `default` object when an ES module imports them.
// Checked with `in`, not read: reading a missing `default` off a vitest module mock throws.
const { NsfwLevel } =
  'default' in shared ? (shared as { default?: typeof shared }).default ?? shared : shared;

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

/** Longest question a player yes/no item may carry; the import and the moderator app both enforce it. */
export const YESNO_QUESTION_MAX = 600;
/** `reason` of a yes/no item a moderator closed. The import never reopens one. */
export const MODERATOR_RETIRED = 'moderator-retired';
export const MODERATION_META_KEY = 'moderation';
export const REWORD_OF_META_KEY = 'rewordOf';

export type ModerationNote = { action: string; by: number; note: string; at: string };

export const moderationMeta = (action: string, by: number, note: string, now: Date) => ({
  [MODERATION_META_KEY]: { action, by, note, at: now.toISOString() } satisfies ModerationNote,
});

/** Unqualified "meta": not usable in an aliased or joined update. */
export const mergeMeta = (patch: Record<string, unknown>) =>
  sql`COALESCE("meta", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;

/** A yes/no item a moderator has acted on. Expects `KnightsQueueItem` unaliased. */
export const isModeratedSql = sql<SqlBool>`COALESCE("KnightsQueueItem"."meta" ? ${sql.lit(
  MODERATION_META_KEY
)}, false)`;

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

/**
 * The caller holds the item row lock, in a transaction. Touches only the item and its votes, never player rows,
 * so the moderator app doesn't take the player locks Knights' close path takes. `settleFinalItems` settles the
 * inconclusive votes later. `metaPatch` is merged into `meta`.
 */
export async function closeYesNoItemRow(
  trx: Kysely<DB> | Transaction<DB>,
  itemId: number,
  reason: string,
  now: Date,
  metaPatch?: Record<string, unknown>
) {
  const at = sql<Date>`${now.toISOString()}::timestamp`;
  await trx
    .updateTable('KnightsQueueItem')
    .set({
      status: 'Closed',
      reason,
      resolvedAt: at,
      updatedAt: at,
      ...(metaPatch ? { meta: mergeMeta(metaPatch) } : {}),
    })
    .where('id', '=', itemId)
    .execute();
  await trx
    .updateTable('KnightsVote')
    .set({ verdict: 'inconclusive' })
    .where('itemId', '=', itemId)
    .where('verdict', '=', 'pending')
    .execute();
}

/** The cosmetics among `ids` that the main app would refuse to equip because they are still in review; the shop neither sells nor lists them. */
export async function withheldCosmetics(db: Kysely<DB>, ids: number[]): Promise<Set<number>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const [cosmetics, listings] = await Promise.all([
    db
      .selectFrom('Cosmetic')
      .select(['id', 'createdById', 'flags'])
      .where('id', 'in', unique)
      .execute(),
    db
      .selectFrom('CosmeticShopItem')
      .select(['cosmeticId', 'addedById', 'status', 'meta', 'rejectionReason'])
      .where('cosmeticId', 'in', unique)
      .execute(),
  ]);
  return withheldCosmeticIds(cosmetics, listings);
}
