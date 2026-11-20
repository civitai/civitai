import { sql, type Kysely, type Transaction } from 'kysely';
import { ESCALATED_FROM_LEVEL_META_KEY } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { metrics, type ReviewOutcome } from '../metrics';
import { readImageState } from '../queue/image-state';
import { hasBlockMarker, moderatorRuling, type ImageState } from '../queue/resolution';
import { skillCheckEligible } from '../skill-check/eligible';
import { addSkillCheck } from '../skill-check/pool';

type Executor = Kysely<DB> | Transaction<DB>;

/** Rating answers a moderator can give; Blocked is not a vote here but "send to the Inquisitors". */
const BLOCKED_VALUE = '32';
/** The tick sweep looks this far back for written-back items whose review was never opened. */
export const REVIEW_SWEEP_WINDOW_HOURS = 48;
/** Source of the Inquisitor item a moderator opens from a review. */
export const REVIEW_HANDOFF_SOURCE = 'inquisitor-review';

/** Written-back rating items a review is opened for: the players' settled, applied answer on a real queue item. */
const reviewable = (db: Executor) =>
  db
    .selectFrom('KnightsQueueItem as i')
    .select([
      'i.id as queueItemId',
      'i.imageId',
      'i.questionKey',
      sql<string>`"i"."resolvedValue"`.as('consensusValue'),
    ])
    .where('i.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .where('i.status', '=', 'Resolved')
    .where('i.appliedAt', 'is not', null)
    .where('i.resolvedValue', 'is not', null)
    .where('i.isHiddenCheck', '=', false);

const insertReviews = (db: Executor, source: ReturnType<typeof reviewable>, now: Date) =>
  db
    .insertInto('KnightsInquisitorReview')
    .columns(['queueItemId', 'imageId', 'questionKey', 'consensusValue', 'createdAt'])
    .expression(source.select(sql<Date>`${utc(now)}::timestamp(3)`.as('createdAt')))
    .onConflict((oc) => oc.column('queueItemId').doNothing())
    .executeTakeFirst();

/** Opens the review of an item whose rating was just written back. Returns whether one was opened. */
export async function openReview(db: Executor, itemId: number, now: Date): Promise<boolean> {
  const result = await insertReviews(db, reviewable(db).where('i.id', '=', itemId), now);
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

/** Opens the reviews `markApplied` failed to open, for items written back within the window. */
export async function sweepMissingReviews(
  db: Executor,
  { now, windowHours = REVIEW_SWEEP_WINDOW_HOURS }: { now: Date; windowHours?: number }
): Promise<number> {
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const result = await insertReviews(
    db,
    reviewable(db)
      .where('i.appliedAt', '>=', utc(since))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsInquisitorReview as r')
              .select(sql<number>`1`.as('one'))
              .whereRef('r.queueItemId', '=', 'i.id')
          )
        )
      ),
    now
  );
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

type OpenReview = { id: number; imageId: number; consensusValue: string };

/**
 * Why a review can no longer produce a check: the image is gone, a moderator ruled on it, it was blocked, it moved off the
 * players' level, or it fell under a review or hold. Null while it still can.
 */
async function exclusionOf(db: Executor, review: OpenReview): Promise<string | null> {
  const image = await readImageState(db, review.imageId);
  if (!image) return 'missing';
  if (hasBlockMarker(image)) return 'blocked';
  if (moderatorRuling(image)) return 'moderator-ruled';
  if (String(image.nsfwLevel) !== review.consensusValue) return 'level-moved';
  const eligible = await db
    .selectFrom('Image as img')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .select('img.id')
    .where('img.id', '=', review.imageId)
    .where(skillCheckEligible)
    .executeTakeFirst();
  return eligible ? null : 'held';
}

async function closeReview(
  db: Executor,
  reviewId: number,
  outcome: ReviewOutcome,
  now: Date,
  confirmedValue: string | null = null
) {
  await db
    .updateTable('KnightsInquisitorReview')
    .set({ status: outcome, confirmedValue, closedAt: utc(now) })
    .where('id', '=', reviewId)
    .where('status', '=', 'open')
    .execute();
  metrics.reviewClosed(outcome);
}

export type ReviewOffer = {
  reviewId: number;
  imageId: number;
  imageKey: string;
  width: number | null;
  height: number | null;
  /** The players' settled level. */
  consensusValue: string;
  /** The image's level now (the same while the review is open). */
  currentLevel: number;
  /** Moderator votes already cast on it (0 or 1). */
  votes: number;
};

const MAX_EXCLUDED_PER_SERVE = 25;

/**
 * The next review for this moderator: one another moderator already voted on first, then the oldest. Never one they voted
 * on or one of their own images. A review that can no longer produce a check is closed `excluded` on the way.
 */
export async function nextReview(
  db: Kysely<DB>,
  { moderatorId, now = new Date() }: { moderatorId: number; now?: Date }
): Promise<ReviewOffer | null> {
  for (let tries = 0; tries < MAX_EXCLUDED_PER_SERVE; tries++) {
    const row = await db
      .selectFrom('KnightsInquisitorReview as r')
      .innerJoin('Image as img', 'img.id', 'r.imageId')
      .select([
        'r.id',
        'r.imageId',
        'r.consensusValue',
        'img.url',
        'img.width',
        'img.height',
        'img.nsfwLevel',
        (eb) =>
          eb
            .selectFrom('KnightsInquisitorVote as v')
            .select(sql<number>`count(*)::int`.as('n'))
            .whereRef('v.reviewId', '=', 'r.id')
            .as('votes'),
      ])
      .where('r.status', '=', 'open')
      .where('img.userId', 'is distinct from', moderatorId)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsInquisitorVote as mine')
              .select(sql<number>`1`.as('one'))
              .whereRef('mine.reviewId', '=', 'r.id')
              .where('mine.moderatorId', '=', moderatorId)
          )
        )
      )
      .orderBy('votes', 'desc')
      .orderBy('r.createdAt', 'asc')
      .orderBy('r.id', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    if (await exclusionOf(db, row)) {
      await closeReview(db, row.id, 'excluded', now);
      continue;
    }
    return {
      reviewId: row.id,
      imageId: row.imageId,
      imageKey: row.url,
      width: row.width,
      height: row.height,
      consensusValue: row.consensusValue,
      currentLevel: row.nsfwLevel,
      votes: Number(row.votes ?? 0),
    };
  }
  return null;
}

export type ReviewVoteRejection =
  | 'not-found'
  | 'not-open'
  | 'bad-answer'
  | 'own-image'
  | 'already-voted'
  | 'override-unavailable';

export type ReviewVoteResult =
  | { status: 'recorded' | 'confirmed' | 'split' | 'excluded' }
  | { status: 'rejected'; reason: ReviewVoteRejection };

export type ReviewVoteDeps = {
  now: () => Date;
  /** Mod-confirmed checks kept (`skillCheckPoolCap`). */
  poolCap: number;
};

async function ratingAnswers(db: Executor, questionKey: string): Promise<string[]> {
  const question = await db
    .selectFrom('KnightsQuestion')
    .select('options')
    .where('key', '=', questionKey)
    .executeTakeFirst();
  const options = Array.isArray(question?.options)
    ? (question.options as { value?: unknown }[])
    : [];
  return options
    .map((o) => o.value)
    .filter((v): v is string => typeof v === 'string' && v !== BLOCKED_VALUE);
}

/**
 * One moderator's vote. The first is recorded; the second closes the review: the same level confirms it and puts the image
 * in the skill-check pool, another level splits it. The review row lock serialises the two, and the vote's key stops a
 * moderator voting twice. Nothing here touches the players' votes, XP or gold.
 */
export async function castReviewVote(
  db: Kysely<DB>,
  input: { reviewId: number; moderatorId: number; answer: string },
  deps: ReviewVoteDeps
): Promise<ReviewVoteResult> {
  const now = deps.now();
  return db.transaction().execute(async (trx): Promise<ReviewVoteResult> => {
    const review = await trx
      .selectFrom('KnightsInquisitorReview')
      .select(['id', 'imageId', 'questionKey', 'consensusValue', 'status'])
      .where('id', '=', input.reviewId)
      .forUpdate()
      .executeTakeFirst();
    if (!review) return { status: 'rejected', reason: 'not-found' };
    if (review.status !== 'open') return { status: 'rejected', reason: 'not-open' };
    if (!(await ratingAnswers(trx, review.questionKey)).includes(input.answer)) {
      return { status: 'rejected', reason: 'bad-answer' };
    }
    const owner = await trx
      .selectFrom('Image')
      .select('userId')
      .where('id', '=', review.imageId)
      .executeTakeFirst();
    if (owner?.userId === input.moderatorId) return { status: 'rejected', reason: 'own-image' };

    const votes = await trx
      .selectFrom('KnightsInquisitorVote')
      .select(['moderatorId', 'answer'])
      .where('reviewId', '=', review.id)
      .execute();
    if (votes.some((v) => v.moderatorId === input.moderatorId)) {
      return { status: 'rejected', reason: 'already-voted' };
    }
    if (await exclusionOf(trx, review)) {
      await closeReview(trx, review.id, 'excluded', now);
      return { status: 'excluded' };
    }

    const [first] = votes;
    const image = (await readImageState(trx, review.imageId)) as ImageState;
    if (first && first.answer === input.answer && String(image.nsfwLevel) !== input.answer) {
      return { status: 'rejected', reason: 'override-unavailable' };
    }

    await trx
      .insertInto('KnightsInquisitorVote')
      .values({
        reviewId: review.id,
        moderatorId: input.moderatorId,
        answer: input.answer,
        createdAt: utc(now),
      })
      .execute();
    if (!first) return { status: 'recorded' };
    if (first.answer !== input.answer) {
      await closeReview(trx, review.id, 'split', now);
      return { status: 'split' };
    }
    await addSkillCheck(trx, {
      imageId: review.imageId,
      answer: input.answer,
      cap: deps.poolCap,
      now,
    });
    await closeReview(trx, review.id, 'confirmed', now, input.answer);
    return { status: 'confirmed' };
  });
}

/**
 * A moderator's "this should be Blocked": a new item at the Inquisitors (escalation `blocked`), where blocking already
 * works, and the review excluded. The settled item and its players' votes are left exactly as they were.
 */
export async function sendToInquisitor(
  db: Kysely<DB>,
  input: { reviewId: number; moderatorId: number },
  deps: { now: () => Date }
): Promise<{ status: 'sent' } | { status: 'rejected'; reason: 'not-found' | 'not-open' }> {
  const now = deps.now();
  return db.transaction().execute(async (trx) => {
    const review = await trx
      .selectFrom('KnightsInquisitorReview')
      .select(['id', 'imageId', 'questionKey', 'status'])
      .where('id', '=', input.reviewId)
      .forUpdate()
      .executeTakeFirst();
    if (!review) return { status: 'rejected' as const, reason: 'not-found' as const };
    if (review.status !== 'open')
      return { status: 'rejected' as const, reason: 'not-open' as const };

    const waiting = await trx
      .selectFrom('KnightsQueueItem')
      .select('id')
      .where('imageId', '=', review.imageId)
      .where('questionKey', '=', review.questionKey)
      .where('status', 'in', ['Inquisitor', 'Ruling'])
      .executeTakeFirst();
    if (!waiting) {
      const image = await readImageState(trx, review.imageId);
      await trx
        .insertInto('KnightsQueueItem')
        .values({
          questionKey: review.questionKey,
          imageId: review.imageId,
          source: REVIEW_HANDOFF_SOURCE,
          minRank: 'Inquisitor',
          votesNeeded: 0,
          status: 'Inquisitor',
          escalationReason: 'blocked',
          expiresAt: null,
          meta: JSON.stringify({ [ESCALATED_FROM_LEVEL_META_KEY]: image?.nsfwLevel ?? null }),
          createdAt: utc(now),
          updatedAt: utc(now),
        })
        .execute();
      metrics.escalation('blocked');
    }
    await closeReview(trx, review.id, 'excluded', now);
    return { status: 'sent' as const };
  });
}
