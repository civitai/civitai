import { sql, type Kysely, type Transaction } from 'kysely';
import { ESCALATED_FROM_LEVEL_META_KEY } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { metrics, type ReviewOutcome } from '../metrics';
import { readImageState } from '../queue/image-state';
import { hasBlockMarker, moderatorRuling, type ImageState } from '../queue/resolution';
import { failClosed, skillCheckEligible } from '../skill-check/eligible';
import { addSkillCheck } from '../skill-check/pool';
import { OverrideWriteError } from './override-error';

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

/** Why a review can never produce a check: closed `excluded`. */
type PermanentExclusion = 'missing' | 'blocked' | 'moderator-ruled' | 'level-moved';
/**
 * A permanent reason; `held`, a review or hold that may lift (the review waits); `unreadable`, a safety check that could not
 * be read (fail closed: nothing served or recorded); null while the review can still produce a check.
 */
type Exclusion = { permanent: PermanentExclusion } | 'held' | 'unreadable' | null;

const MODERATOR_RULING_ACTIVITY = 'setNsfwLevel';

/** The closing moderator's own ruling at `level`, recorded after `since` (their claim): their override landing, no one else's. */
async function ownRuling(
  db: Executor,
  imageId: number,
  { moderatorId, since }: { moderatorId: number; since: Date }
): Promise<boolean> {
  const row = await db
    .selectFrom('ModActivity')
    .select('id')
    .where('activity', '=', MODERATOR_RULING_ACTIVITY)
    .where('entityType', '=', 'image')
    .where('entityId', '=', imageId)
    .where('userId', '=', moderatorId)
    .where('createdAt', '>=', utc(since))
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

async function exclusionOf(
  db: Executor,
  review: OpenReview,
  /**
   * An image ruled at `level` that this is the vote's own write: `written` when this very request wrote it, else only a
   * ruling the same moderator recorded after `since`.
   */
  own:
    | { level: string; written: true }
    | { level: string; moderatorId: number; since: Date }
    | null = null
): Promise<Exclusion> {
  const image = await readImageState(db, review.imageId);
  if (!image) return { permanent: 'missing' };
  if (hasBlockMarker(image)) return { permanent: 'blocked' };
  const ruled = moderatorRuling(image) !== null;
  const ownWrite =
    own !== null &&
    String(image.nsfwLevel) === own.level &&
    ruled &&
    ('written' in own || (await ownRuling(db, review.imageId, own)));
  if (!ownWrite && ruled) return { permanent: 'moderator-ruled' };
  if (!ownWrite && String(image.nsfwLevel) !== review.consensusValue) {
    return { permanent: 'level-moved' };
  }
  return heldOrUnreadable(db, review.imageId);
}

/** The safety exclusions, which may lift: `held`, or `unreadable` when they cannot be read (fail closed). */
const heldOrUnreadable = (db: Executor, imageId: number): Promise<Exclusion> =>
  failClosed(
    db,
    'the safety exclusions of a review',
    async (): Promise<Exclusion> =>
      (await db
        .selectFrom('Image as img')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select('img.id')
        .where('img.id', '=', imageId)
        .where(skillCheckEligible)
        .executeTakeFirst())
        ? null
        : 'held',
    'unreadable'
  );

async function closeReview(
  db: Executor,
  reviewId: number,
  outcome: ReviewOutcome,
  now: Date,
  confirmedValue: string | null = null
) {
  await db
    .updateTable('KnightsInquisitorReview')
    .set({
      status: outcome,
      confirmedValue,
      closedAt: utc(now),
      claimedBy: null,
      claimExpiresAt: null,
    })
    .where('id', '=', reviewId)
    .where('status', '=', 'open')
    .execute();
  metrics.reviewClosed(outcome);
}

const releaseClaim = (db: Executor, reviewId: number, moderatorId: number) =>
  db
    .updateTable('KnightsInquisitorReview')
    .set({ claimedBy: null, claimExpiresAt: null })
    .where('id', '=', reviewId)
    .where('claimedBy', '=', moderatorId)
    .execute();

export type ReviewOffer = {
  reviewId: number;
  /** The settled queue item the review is of. */
  queueItemId: number;
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

/** Candidates read per serve from each of the two queues; a held review is skipped, not closed. */
const SERVE_BATCH = 20;

/** Open reviews this moderator may vote on: not claimed by another, not their own image, not voted on by them. */
const servable = (db: Kysely<DB>, moderatorId: number, now: Date) =>
  db
    .selectFrom('KnightsInquisitorReview as r')
    .innerJoin('Image as img', 'img.id', 'r.imageId')
    .select([
      'r.id',
      'r.queueItemId',
      'r.imageId',
      'r.consensusValue',
      'img.url',
      'img.width',
      'img.height',
      'img.nsfwLevel',
    ])
    .where('r.status', '=', 'open')
    .where((eb) =>
      eb.or([
        eb('r.claimedBy', 'is', null),
        eb('r.claimedBy', '=', moderatorId),
        eb('r.claimExpiresAt', '<=', utc(now)),
      ])
    )
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
    );

const hasVote = (exists: boolean) => (qb: ReturnType<typeof servable>) =>
  qb.where((eb) => {
    const voted = eb.exists(
      eb
        .selectFrom('KnightsInquisitorVote as v')
        .select(sql<number>`1`.as('one'))
        .whereRef('v.reviewId', '=', 'r.id')
    );
    return exists ? voted : eb.not(voted);
  });

/**
 * The next review for this moderator: one another moderator already voted on first, then the oldest, each read as one
 * bounded batch in `(status, createdAt)` order. A review that can never produce a check is closed `excluded` on the way;
 * one under a review or hold is skipped and stays open; unreadable safety checks serve nothing.
 */
export async function nextReview(
  db: Kysely<DB>,
  { moderatorId, now = new Date() }: { moderatorId: number; now?: Date }
): Promise<ReviewOffer | null> {
  for (const voted of [true, false]) {
    const batch = await servable(db, moderatorId, now)
      .$call(hasVote(voted))
      .orderBy('r.createdAt', 'asc')
      .orderBy('r.id', 'asc')
      .limit(SERVE_BATCH)
      .execute();
    for (const row of batch) {
      const exclusion = await exclusionOf(db, row);
      if (exclusion === 'unreadable') return null;
      if (exclusion === 'held') continue;
      if (exclusion) {
        await closeReview(db, row.id, 'excluded', now);
        continue;
      }
      return {
        reviewId: row.id,
        queueItemId: row.queueItemId,
        imageId: row.imageId,
        imageKey: row.url,
        width: row.width,
        height: row.height,
        consensusValue: row.consensusValue,
        currentLevel: row.nsfwLevel,
        votes: voted ? 1 : 0,
      };
    }
  }
  return null;
}

export type ReviewVoteRejection =
  | 'not-found'
  | 'not-open'
  | 'bad-answer'
  | 'own-image'
  | 'already-voted'
  | 'claimed'
  | 'held'
  | 'unavailable'
  | 'override-unavailable'
  | 'override-failed'
  | 'override-uncertain';

export type ReviewVoteResult =
  /** `written-not-closed`: the agreed level reached the image, but the review could not be closed and no check was added. */
  | { status: 'recorded' | 'confirmed' | 'split' | 'excluded' | 'written-not-closed' }
  | { status: 'rejected'; reason: ReviewVoteRejection };

export type ReviewVoteDeps = {
  now: () => Date;
  /** Mod-confirmed checks kept (`skillCheckPoolCap`). */
  poolCap: number;
  /**
   * Writes the agreed level as the closing moderator's ruling (`setImageLevelAsModerator` with their session). Throws an
   * `OverrideWriteError` when it fails. Absent, an agreement on a level other than the image's is refused.
   */
  setImageLevel?: (imageId: number, level: number) => Promise<void>;
};

/** How long a closing moderator holds a review while their level is written to the image. */
const CLAIM_MS = 2 * 60_000;

/** Rolls the closing transaction back: the pool could not take the image. */
class PoolRefused extends Error {}

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

const inTransaction = async (
  db: Kysely<DB>,
  run: (trx: Transaction<DB>) => Promise<VoteStep>
): Promise<VoteStep> => {
  try {
    return await db.transaction().execute(run);
  } catch (error) {
    if (error instanceof PoolRefused) {
      return { kind: 'done', result: { status: 'rejected', reason: 'unavailable' } };
    }
    throw error;
  }
};

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
  const first = await inTransaction(db, (trx) => voteOrClaim(trx, input, deps, deps.now()));
  if (first.kind === 'done') return first.result;

  // The closing vote names another level. Check the image once more right before writing it, then write it as a moderator
  // ruling, holding no lock or transaction across the call.
  const before = await exclusionOf(db, first.review);
  if (before !== null) {
    await releaseClaim(db, input.reviewId, input.moderatorId);
    if (before === 'held') return { status: 'rejected', reason: 'held' };
    if (before === 'unreadable') return { status: 'rejected', reason: 'unavailable' };
    await closeReview(db, input.reviewId, 'excluded', deps.now());
    return { status: 'excluded' };
  }
  try {
    await deps.setImageLevel!(first.review.imageId, Number(input.answer));
  } catch (error) {
    // The write may have landed without an answer: an image now ruled at the agreed level is taken as written.
    const image = await readImageState(db, first.review.imageId);
    const landed =
      !!image && String(image.nsfwLevel) === input.answer && moderatorRuling(image) !== null;
    console.error("knights: could not confirm the moderators' level was written", {
      reviewId: input.reviewId,
      landed,
      error,
    });
    if (!landed) {
      await releaseClaim(db, input.reviewId, input.moderatorId);
      const ambiguous = !(error instanceof OverrideWriteError) || error.ambiguous;
      return { status: 'rejected', reason: ambiguous ? 'override-uncertain' : 'override-failed' };
    }
  }
  const second = await inTransaction(db, (trx) =>
    voteOrClaim(trx, input, deps, deps.now(), { overrideWritten: true })
  );
  if (second.kind === 'done' && second.result.status === 'confirmed') return second.result;
  console.error("knights: the moderators' level was written but the review was not closed", {
    reviewId: input.reviewId,
    result: second.kind === 'done' ? second.result : second.kind,
  });
  metrics.overrideUnclosed();
  return { status: 'written-not-closed' };
}

type VoteStep =
  | { kind: 'done'; result: ReviewVoteResult }
  | { kind: 'override'; review: OpenReview };

const claimHeldByOther = (
  review: { claimedBy: number | null; claimExpiresAt: Date | null },
  moderatorId: number,
  now: Date
) =>
  review.claimedBy !== null &&
  review.claimedBy !== moderatorId &&
  review.claimExpiresAt !== null &&
  review.claimExpiresAt > now;

async function voteOrClaim(
  trx: Transaction<DB>,
  input: { reviewId: number; moderatorId: number; answer: string },
  deps: ReviewVoteDeps,
  now: Date,
  { overrideWritten = false }: { overrideWritten?: boolean } = {}
): Promise<VoteStep> {
  const done = (result: ReviewVoteResult): VoteStep => ({ kind: 'done', result });
  const review = await trx
    .selectFrom('KnightsInquisitorReview')
    .select([
      'id',
      'imageId',
      'questionKey',
      'consensusValue',
      'status',
      'claimedBy',
      'claimExpiresAt',
    ])
    .where('id', '=', input.reviewId)
    .forUpdate()
    .executeTakeFirst();
  if (!review) return done({ status: 'rejected', reason: 'not-found' });
  if (review.status !== 'open') return done({ status: 'rejected', reason: 'not-open' });
  if (claimHeldByOther(review, input.moderatorId, now)) {
    return done({ status: 'rejected', reason: 'claimed' });
  }
  if (!(await ratingAnswers(trx, review.questionKey)).includes(input.answer)) {
    return done({ status: 'rejected', reason: 'bad-answer' });
  }
  const owner = await trx
    .selectFrom('Image')
    .select('userId')
    .where('id', '=', review.imageId)
    .executeTakeFirst();
  if (owner?.userId === input.moderatorId) return done({ status: 'rejected', reason: 'own-image' });

  const votes = await trx
    .selectFrom('KnightsInquisitorVote')
    .select(['moderatorId', 'answer'])
    .where('reviewId', '=', review.id)
    .execute();
  if (votes.some((v) => v.moderatorId === input.moderatorId)) {
    return done({ status: 'rejected', reason: 'already-voted' });
  }
  const [first] = votes;
  const agrees = first?.answer === input.answer;
  // Only this moderator's own override may have moved the image: written in this request, or recorded under their claim.
  const own = !agrees
    ? null
    : overrideWritten
    ? { level: input.answer, written: true as const }
    : review.claimedBy === input.moderatorId && review.claimExpiresAt
    ? {
        level: input.answer,
        moderatorId: input.moderatorId,
        since: new Date(review.claimExpiresAt.getTime() - CLAIM_MS),
      }
    : null;
  const exclusion = await exclusionOf(trx, review, own);
  if (exclusion === 'unreadable') return done({ status: 'rejected', reason: 'unavailable' });
  if (exclusion === 'held') return done({ status: 'rejected', reason: 'held' });
  if (exclusion) {
    await closeReview(trx, review.id, 'excluded', now);
    return done({ status: 'excluded' });
  }

  const image = (await readImageState(trx, review.imageId)) as ImageState;
  if (agrees && String(image.nsfwLevel) !== input.answer) {
    if (overrideWritten) return done({ status: 'rejected', reason: 'unavailable' });
    if (!deps.setImageLevel) return done({ status: 'rejected', reason: 'override-unavailable' });
    await trx
      .updateTable('KnightsInquisitorReview')
      .set({
        claimedBy: input.moderatorId,
        claimExpiresAt: utc(new Date(now.getTime() + CLAIM_MS)),
      })
      .where('id', '=', review.id)
      .execute();
    return { kind: 'override', review };
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
  if (!first) return done({ status: 'recorded' });
  if (!agrees) {
    await closeReview(trx, review.id, 'split', now);
    return done({ status: 'split' });
  }
  const pooled = await addSkillCheck(trx, {
    imageId: review.imageId,
    answer: input.answer,
    cap: deps.poolCap,
    now,
  });
  // An image the pool cannot take now (held, or its checks unreadable) rolls the vote back for a retry.
  if (pooled === 'ineligible' || pooled === 'unreadable') throw new PoolRefused(pooled);
  await closeReview(trx, review.id, 'confirmed', now, input.answer);
  return done({ status: 'confirmed' });
}

/**
 * A moderator's "this should be Blocked": a new item at the Inquisitors (escalation `blocked`), where blocking already
 * works, and the review excluded. The settled item and its players' votes are left exactly as they were.
 */
export async function sendToInquisitor(
  db: Kysely<DB>,
  input: { reviewId: number; moderatorId: number },
  deps: { now: () => Date }
): Promise<
  { status: 'sent' } | { status: 'rejected'; reason: 'not-found' | 'not-open' | 'claimed' }
> {
  const now = deps.now();
  return db.transaction().execute(async (trx) => {
    const review = await trx
      .selectFrom('KnightsInquisitorReview')
      .select(['id', 'imageId', 'questionKey', 'status', 'claimedBy', 'claimExpiresAt'])
      .where('id', '=', input.reviewId)
      .forUpdate()
      .executeTakeFirst();
    if (!review) return { status: 'rejected' as const, reason: 'not-found' as const };
    if (review.status !== 'open')
      return { status: 'rejected' as const, reason: 'not-open' as const };
    // A moderator mid-override holds it: their level may be on its way to the image.
    if (claimHeldByOther(review, input.moderatorId, now))
      return { status: 'rejected' as const, reason: 'claimed' as const };

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
