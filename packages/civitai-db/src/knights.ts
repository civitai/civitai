import { sql, type ExpressionBuilder, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import * as shared from '@civitai/shared';
import { withheldCosmeticIds } from '@civitai/shared/knights-shop';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';

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
  /** A hidden check served to collect answers: it grades nobody, and its players' agreement promotes or retires it. */
  probation: 'probation',
  retired: 'retired',
} as const;

/** Longest question a player yes/no item may carry; the import and the moderator app both enforce it. */
export const YESNO_QUESTION_MAX = 600;
/** `reason` of a yes/no item a moderator closed. The import never reopens one. */
export const MODERATOR_RETIRED = 'moderator-retired';
export const MODERATION_META_KEY = 'moderation';
export const REWORD_OF_META_KEY = 'rewordOf';
/** The image's level when a rating item went to the Inquisitors: what "pushed down" was measured from. */
export const ESCALATED_FROM_LEVEL_META_KEY = 'escalatedFromLevel';

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
 * The image half of `servableImage`, whatever its post's state: a rated still image with no block marker, no review hold,
 * and no real-person or minor flag (those go to the moderators' own queues). Expects `Image as img` joined to `Post as p`.
 */
export const servableImageContent = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([
    eb('img.type', '=', 'image'),
    eb('img.nsfwLevel', 'not in', [0, NsfwLevel.Blocked]),
    eb('img.ingestion', '!=', 'Blocked'),
    eb('img.blockedFor', 'is', null),
    eb('img.needsReview', 'is', null),
    eb('img.acceptableMinor', '=', false),
    eb('img.poi', '=', false),
    eb('img.minor', '=', false),
  ]);

/** The post is not Private. Unsearchable and EarlyAccess posts stay served, as the site serves them. */
export const postNotPrivate = (eb: ExpressionBuilder<Joined, 'p'>) =>
  eb('p.availability', '!=', 'Private');

/**
 * `servableImageContent` on a published post, without the rules that must only hide an image (`postNotPrivate`): for
 * sweeps that would otherwise retire a reference or close a question over them. Expects `Image as img` joined to
 * `Post as p`.
 */
export const servableImageForSweeps = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([
    servableImageContent(eb),
    eb('p.publishedAt', 'is not', null),
    eb('p.publishedAt', '<', sql<Date>`(now() AT TIME ZONE 'utc')`),
  ]);

/**
 * Images Knights may show players: `servableImageForSweeps` on a post that is not Private. Expects `Image as img`
 * joined to `Post as p`.
 */
export const servableImage = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([servableImageForSweeps(eb), postNotPrivate(eb)]);

/**
 * Open Knight-stage rating items that players can be served, counted up to `limit` (the intake cap reads `maxOpen + 1`).
 * Items whose image fails `servableImage` cannot be judged, so they must not fill the cap and pause intake while players
 * run out of work.
 */
export async function countOpenServableKnightItems(db: Kysely<DB>, limit: number): Promise<number> {
  const row = await db
    .selectFrom(
      db
        .selectFrom('KnightsQueueItem as i')
        .innerJoin('Image as img', 'img.id', 'i.imageId')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select(sql<number>`1`.as('one'))
        .where('i.status', '=', 'Open')
        .where('i.minRank', '=', 'Knight')
        .where('i.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
        .where(servableImage)
        .limit(limit)
        .as('open')
    )
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

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
