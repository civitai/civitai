import { sql, type ExpressionBuilder, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import * as shared from '@civitai/shared';
import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL, heldImageKnownSql } from '@civitai/shared/held-media';
import { withheldCosmeticIds } from '@civitai/shared/knights-shop';
import { KNIGHTS_NSFW_LEVEL_QUESTION, KNIGHTS_STAGE_RANKS } from '@civitai/shared/new-order';

// tsx loads CommonJS-scoped workspace packages as one `default` object when an ES module imports them.
// Checked with `in`, not read: reading a missing `default` off a vitest module mock throws.
const { NsfwLevel } =
  'default' in shared ? (shared as { default?: typeof shared }).default ?? shared : shared;

export const REFERENCE_POOL = {
  trials: 'trials',
  hiddenCheck: 'hiddenCheck',
  /** Mod-confirmed checks from the in-game inquisitor queue, served to Acolytes and Knights alike. */
  skillCheck: 'skillCheck',
} as const;
export const REFERENCE_SOURCE = {
  core: 'core',
  harvested: 'harvested',
  agreement: 'agreement',
  /** Two agreeing moderators in the in-game inquisitor queue. */
  inquisitor: 'inquisitor',
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

/** The SQL comment `servableImageContent` carries, which the test harnesses look for to check a read ran with JIT off. */
export const SERVABLE_IMAGE_CONTENT_MARKER = '/* servable-image-content */';

/**
 * The content half of `servableImage`, independent of the post's publish state and privacy: a rated still image with
 * no block marker, no review hold, no real-person or minor flag (those go to the moderators' own queues), no CSAM flag or
 * held owner (`heldImageSql`), no listing on a CSAM report, no ToS violation, an uploader who is not deleted, and no
 * model or version on its post that is deleted or unpublished for a violation. Sweeps close items and retire references
 * over a failure here. Some of these states can lift (a hold, a ToS flag, an unpublish for a violation) and nothing
 * reopens what they closed, by design; a state that should only hide belongs in `imageSourceVisible`. Keep every clause
 * true or false, never NULL: the queue sweep reads `NOT servableImageContent` while other sweeps test membership, and a
 * NULL would split them. Expects `Image as img` joined to `Post as p`.
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
    eb('img.tosViolation', '=', false),
    // Marks the read for the test harnesses' JIT check (`readWithoutJit`); always true.
    sql<SqlBool>`${sql.raw(SERVABLE_IMAGE_CONTENT_MARKER)} true`,
    // A clean image's nullable columns make the held check NULL, not false.
    sql<SqlBool>`NOT ${sql.raw(heldImageKnownSql('img'))}`,
    sql<SqlBool>`(img.id)::text NOT IN (${sql.raw(CSAM_REPORT_LISTED_IMAGE_IDS_SQL)})`,
    eb.not(
      eb.exists(
        eb
          .selectFrom('User as owner')
          .select(sql<number>`1`.as('one'))
          .whereRef('owner.id', '=', 'img.userId')
          .where('owner.deletedAt', 'is not', null)
      )
    ),
    eb.not(
      eb.exists(
        eb
          .selectFrom('ModelVersion as mv')
          .innerJoin('Model as m', 'm.id', 'mv.modelId')
          .select(sql<number>`1`.as('one'))
          .whereRef('mv.id', '=', 'p.modelVersionId')
          .where((w) =>
            w.or([
              w('mv.status', 'in', ['Deleted', 'UnpublishedViolation']),
              w('m.status', 'in', ['Deleted', 'UnpublishedViolation']),
              w('m.deletedAt', 'is not', null),
            ])
          )
      )
    ),
  ]);

/**
 * Post availabilities whose images Knights shows, as the site serves them. An allow-list: a new Availability value stays
 * hidden until it is added here.
 */
export const KNIGHTS_SHOWN_POST_AVAILABILITIES = ['Public', 'Unsearchable', 'EarlyAccess'] as const;

/** The opposite of `postShownToKnights`, for a row already read: the same list, and a missing value is hidden. */
export const postHiddenFromKnights = (availability: string | null | undefined): boolean =>
  availability == null ||
  !(KNIGHTS_SHOWN_POST_AVAILABILITIES as readonly string[]).includes(availability);

/** The post's availability is one Knights shows. */
export const postShownToKnights = (eb: ExpressionBuilder<Joined, 'p'>) =>
  eb('p.availability', 'in', KNIGHTS_SHOWN_POST_AVAILABILITIES);

/**
 * Hides an image whose uploader is banned or muted, or whose post's model or version is not Published or is Private. Each
 * can be lifted, so this only hides: it stays out of `servableImageForSweeps`. Expects `Image as img` joined to
 * `Post as p`.
 */
export const imageSourceVisible = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([
    eb.not(
      eb.exists(
        eb
          .selectFrom('User as owner')
          .select(sql<number>`1`.as('one'))
          .whereRef('owner.id', '=', 'img.userId')
          .where((w) => w.or([w('owner.bannedAt', 'is not', null), w('owner.muted', '=', true)]))
      )
    ),
    eb.not(
      eb.exists(
        eb
          .selectFrom('ModelVersion as mv')
          .innerJoin('Model as m', 'm.id', 'mv.modelId')
          .select(sql<number>`1`.as('one'))
          .whereRef('mv.id', '=', 'p.modelVersionId')
          .where((w) =>
            w.or([
              w('mv.status', '!=', 'Published'),
              w('mv.availability', '=', 'Private'),
              w('m.status', '!=', 'Published'),
              w('m.availability', '=', 'Private'),
            ])
          )
      )
    ),
  ]);

/**
 * `servableImageContent` on a published post, without the rules that must only hide an image (`postShownToKnights`): for
 * sweeps that would otherwise retire a reference or close a question over them. Expects `Image as img` joined to
 * `Post as p`.
 */
export const servableImageForSweeps = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([
    servableImageContent(eb),
    eb('p.publishedAt', 'is not', null),
    eb('p.publishedAt', '<', sql<Date>`(now() AT TIME ZONE 'utc')`),
  ]);

/** `source` of the yes/no items Paladins answer for the moderator tag review queue. */
export const MOD_TAG_REVIEW_SOURCE = 'mod-tag-review';
/** The axis of those items; its question key is `knights.yesno.tag_review`. */
export const MOD_TAG_REVIEW_AXIS = 'tag_review';

/**
 * Images players may judge for a moderator review queue: `servableImageContent` and no open report on the image.
 * Everything else stays staff-only. Used where the tag review item is created, served, voted on and swept, and by the
 * moderator app's write-back guard. Expects `Image as img` joined to `Post as p`; the post half is the caller's
 * (`servableImage` for serving).
 */
export const modReviewEligibleImage = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([
    servableImageContent(eb),
    sql<SqlBool>`NOT EXISTS (
      SELECT 1 FROM "ImageReport" ir JOIN "Report" r ON r.id = ir."reportId"
      WHERE ir."imageId" = img.id AND r.status IN ('Pending', 'Processing')
    )`,
  ]);

/**
 * Whether disabling `tagId` on the image would lower its `nsfwLevel`, read as `update_nsfw_levels_new` decides it: the
 * highest level among the image's other enabled tags (1 with none rated), floored by `metadata.judgeRating`, written only
 * when the image is not `nsfwLevelLocked`. Two cases are deliberately stricter than the function and count as lowering:
 * an image whose ingestion is not `Scanned`, and an image with no other enabled tag (the function leaves both levels
 * alone). A missing image counts as lowering too. Read-only; the test pinning it to the function loads its migration.
 */
export async function removalLowersLevel(
  db: Kysely<DB> | Transaction<DB>,
  imageId: number,
  tagId: number | null | undefined
): Promise<boolean> {
  if (typeof tagId !== 'number' || !Number.isInteger(tagId)) return true;
  const { rows } = await sql<{
    locked: boolean;
    level: number;
    scanned: boolean;
    others: number;
    otherLevel: number | null;
    judge: number | null;
  }>`
    SELECT i."nsfwLevelLocked" AS locked, i."nsfwLevel" AS level, i.ingestion::text = 'Scanned' AS scanned,
      (SELECT count(*)::int FROM "TagsOnImageDetails" d
        WHERE d."imageId" = i.id AND NOT d.disabled AND d."tagId" <> ${tagId}) AS others,
      (SELECT max(t."nsfwLevel")::int FROM "TagsOnImageDetails" d
        JOIN "Tag" t ON t.id = d."tagId" AND t."nsfwLevel" > 1
        WHERE d."imageId" = i.id AND NOT d.disabled AND d."tagId" <> ${tagId}) AS "otherLevel",
      CASE
        WHEN jsonb_typeof(i.metadata -> 'judgeRating' -> 'nsfwLevel') = 'number'
          AND (i.metadata -> 'judgeRating' -> 'nsfwLevel')::text IN ('1', '2', '4', '8', '16')
        THEN (i.metadata -> 'judgeRating' -> 'nsfwLevel')::text::int
      END AS judge
    FROM "Image" i
    WHERE i.id = ${imageId}
  `.execute(db);
  const image = rows[0];
  if (!image) return true;
  if (image.locked) return false;
  if (!image.scanned || image.others === 0) return true;
  const after = Math.max(image.otherLevel ?? 1, image.judge ?? 0);
  return after < image.level;
}

/**
 * Runs a read that applies `servableImageContent` with JIT off (SET LOCAL, so in a transaction: the caller's, or one
 * opened here). Its CSAM subplans inflate the
 * planner's estimate far past the read's real cost, and on a server with JIT on, compiling for that estimate costs more
 * than the read.
 */
export async function readWithoutJit<T>(
  db: Kysely<DB>,
  read: (trx: Kysely<DB>) => Promise<T>
): Promise<T> {
  // Already in a transaction: turn JIT off in it rather than nest one, which Kysely refuses.
  if (db.isTransaction) {
    await sql`SET LOCAL jit = off`.execute(db);
    return read(db);
  }
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL jit = off`.execute(trx);
    return read(trx);
  });
}

/**
 * Images Knights may show players: `servableImageForSweeps` on a post whose availability Knights shows (`postShownToKnights`), with `imageSourceVisible`.
 * Expects `Image as img` joined to `Post as p`.
 */
export const servableImage = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([servableImageForSweeps(eb), postShownToKnights(eb), imageSourceVisible(eb)]);

/**
 * Open Knight-stage rating items that players can be served, counted up to `limit` (the intake cap reads `maxOpen + 1`).
 * Items whose image fails `servableImage` cannot be judged, so they must not fill the cap and pause intake while players
 * run out of work.
 */
export async function countOpenServableKnightItems(db: Kysely<DB>, limit: number): Promise<number> {
  const row = await readWithoutJit(db, (trx) =>
    trx
      .selectFrom(
        trx
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
      .executeTakeFirstOrThrow()
  );
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

/** The counted votes on a settled item for one answer: how many, their weight, and how many came at each stage. */
export type KnightsAnswerTally = {
  answer: string;
  label: string;
  votes: number;
  weight: number;
  /** Votes for this answer by the stage the item was at when they were cast, lowest stage first; stages with none are left out. A higher rank can vote at a lower stage, so this is not the voter's rank. */
  stages: { stage: string; votes: number }[];
};

type StageTally = { itemId: number; answer: string; stage: string; votes: string; weight: number };

/** Per item, answer and stage, the counted votes (a held player's weight-0 vote decided nothing and is left out). */
export function readVoteTallies(db: Kysely<DB>, itemIds: number[]): Promise<StageTally[]> {
  return db
    .selectFrom('KnightsVote')
    .select([
      'itemId',
      'answer',
      'stage',
      sql<string>`count(*)`.as('votes'),
      sql<number>`sum("weight")`.as('weight'),
    ])
    .where('itemId', 'in', itemIds)
    .where('weight', '>', 0)
    .groupBy(['itemId', 'answer', 'stage'])
    .execute();
}

const stageOrder = (stage: string) => {
  const index = (KNIGHTS_STAGE_RANKS as readonly string[]).indexOf(stage);
  return index === -1 ? KNIGHTS_STAGE_RANKS.length : index;
};

/** One item's stage tallies grouped by answer, heaviest first, each answer's stages lowest first. */
export function tallyByAnswer(
  tallies: Pick<StageTally, 'answer' | 'stage' | 'votes' | 'weight'>[],
  labels: Map<string, string>
): KnightsAnswerTally[] {
  const byAnswer = new Map<string, KnightsAnswerTally>();
  for (const tally of tallies) {
    const vote = byAnswer.get(tally.answer) ?? {
      answer: tally.answer,
      label: labels.get(tally.answer) ?? tally.answer,
      votes: 0,
      weight: 0,
      stages: [],
    };
    vote.votes += Number(tally.votes);
    vote.weight += Number(tally.weight);
    vote.stages.push({ stage: tally.stage, votes: Number(tally.votes) });
    byAnswer.set(tally.answer, vote);
  }
  return [...byAnswer.values()]
    .map((vote) => ({
      ...vote,
      stages: vote.stages.sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage)),
    }))
    .sort((a, b) => b.weight - a.weight || a.answer.localeCompare(b.answer));
}
