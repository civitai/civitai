import { sql, type Kysely, type Transaction } from 'kysely';
import { ESCALATED_FROM_LEVEL_META_KEY } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { metrics, type ReviewOutcome } from '../metrics';
import { readImageState } from '../queue/image-state';
import { hasBlockMarker, moderatorRuling, type ImageState } from '../queue/resolution';
import {
  failClosed,
  skillCheckEligible,
  skillCheckLasting,
  withoutJit,
} from '../skill-check/eligible';
import type { SkillCheckReadSite } from '../metrics';
import { addSkillCheck } from '../skill-check/pool';
import { OverrideWriteError } from './override-error';

type Executor = Kysely<DB> | Transaction<DB>;

/** Rating answers a moderator can give; Blocked is not a vote here but "send to the Inquisitors". */
const BLOCKED_VALUE = '32';
/** The tick sweep looks this far back for written-back items whose review was never opened. */
export const REVIEW_SWEEP_WINDOW_HOURS = 2;
/** Reviews the entry sweep opens at most per run: `markApplied` is the entry, this only catches its misses. */
export const REVIEW_SWEEP_LIMIT = 500;
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
  {
    now,
    windowHours = REVIEW_SWEEP_WINDOW_HOURS,
    limit = REVIEW_SWEEP_LIMIT,
  }: { now: Date; windowHours?: number; limit?: number }
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
      )
      .orderBy('i.appliedAt', 'desc')
      .limit(limit),
    now
  );
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

type OpenReview = { id: number; imageId: number; consensusValue: string };

/** Why a review can never produce a check: closed `excluded`. */
type PermanentExclusion = 'missing' | 'blocked' | 'moderator-ruled' | 'level-moved' | 'ineligible';
/**
 * A permanent reason; `held`, a review or hold that may lift (the review waits); `unreadable`, a safety check that could not
 * be read (fail closed: nothing served or recorded); null while the review can still produce a check.
 */
type Exclusion = { permanent: PermanentExclusion } | 'held' | 'unreadable' | null;

const MODERATOR_RULING_ACTIVITY = 'setNsfwLevel';
const CLOCK_SKEW_MS = 30_000;

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
    // A little before the claim, for clock skew between this app and the main app's database.
    .where('createdAt', '>=', utc(new Date(since.getTime() - CLOCK_SKEW_MS)))
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
  // After the moderators' own write, judge the level-dependent exclusions at the players' level: the agreed level only
  // decides whether the image becomes a check (the pool insert), never whether the moderators' level stands.
  return heldOrUnreadable(
    db,
    review.imageId,
    'review',
    ownWrite ? Number(review.consensusValue) : undefined
  );
}

/**
 * The safety exclusions: `{ permanent: 'ineligible' }` for one that never lifts on its own (closed `excluded`), `held` for
 * one that may (the review waits), `unreadable` when they cannot be read (fail closed). `level`: judge the image as if it
 * were at that level (some exclusions depend on it).
 */
const heldOrUnreadable = (
  db: Executor,
  imageId: number,
  site: SkillCheckReadSite = 'review',
  level?: number
): Promise<Exclusion> =>
  failClosed(
    db,
    site,
    async (): Promise<Exclusion> => {
      const row = await db
        .selectFrom('Image as img')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select((eb) => [
          skillCheckEligible(eb, { level }).as('eligible'),
          skillCheckLasting(eb, { level }).as('lasting'),
        ])
        .where('img.id', '=', imageId)
        .executeTakeFirst();
      if (!row || !row.lasting) return { permanent: 'ineligible' };
      return row.eligible ? null : 'held';
    },
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

const SERVE_BATCH_PER_QUEUE = 20;

/**
 * Open reviews this moderator may vote on: not claimed by another, not their own image, not voted on by them, and on an
 * image that passes the safety exclusions now (so held reviews never fill a batch). Exported for the waiting count.
 */
export const servableReviews = (db: Kysely<DB>, moderatorId: number, now: Date) =>
  db
    .selectFrom('KnightsInquisitorReview as r')
    .innerJoin('Image as img', 'img.id', 'r.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
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
    )
    .where((eb) => skillCheckEligible(eb));

const hasVote = (exists: boolean) => (qb: ReturnType<typeof servableReviews>) =>
  qb.where((eb) => {
    const voted = eb.exists(
      eb
        .selectFrom('KnightsInquisitorVote as v')
        .select(sql<number>`1`.as('one'))
        .whereRef('v.reviewId', '=', 'r.id')
    );
    return exists ? voted : eb.not(voted);
  });

/** Open reviews the close sweep checks per run. */
export const INELIGIBLE_SWEEP_BATCH = 200;
/** The close sweep's statement timeout: a slow read gives up and closes nothing rather than holding row locks. */
const SWEEP_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The close sweep's candidates: open reviews no moderator is claiming, least recently checked first, `batch` at most, row
 * locked with SKIP LOCKED so a review a vote holds is passed over rather than waited on. Exported for its test.
 */
export const ineligibleSweepCandidates = (
  db: Executor,
  { now, batch }: { now: Date; batch: number }
) =>
  db
    .selectFrom('KnightsInquisitorReview')
    .select(['id', 'imageId'])
    .where('status', '=', 'open')
    .where((eb) => eb.or([eb('claimedBy', 'is', null), eb('claimExpiresAt', '<=', utc(now))]))
    .orderBy(sql`"checkedAt" asc nulls first`)
    .orderBy('id', 'asc')
    .limit(batch)
    .forUpdate()
    .skipLocked();

/**
 * Checks a small batch of open reviews against the safety exclusions that never lift on their own (`skillCheckLasting`),
 * closes those that fail as `excluded` and stamps the rest `checkedAt`, so the next run takes others. The predicate runs
 * on the batch only, in one short transaction under a statement timeout; unreadable, it changes nothing (fail closed).
 * Run by the tick. Returns how many it closed.
 */
export async function closeIneligibleReviews(
  db: Kysely<DB>,
  { now, batch = INELIGIBLE_SWEEP_BATCH }: { now: Date; batch?: number }
): Promise<number> {
  const closed = await failClosed(
    db,
    'review-sweep',
    () =>
      db.transaction().execute(async (trx) => {
        await sql.raw(`SET LOCAL statement_timeout = ${SWEEP_STATEMENT_TIMEOUT_MS}`).execute(trx);
        const candidates = await ineligibleSweepCandidates(trx, { now, batch }).execute();
        if (candidates.length === 0) return 0;
        const ids = candidates.map((c) => c.id);
        const checked = await trx
          .selectFrom('KnightsInquisitorReview as r')
          .leftJoin('Image as img', 'img.id', 'r.imageId')
          .leftJoin('Post as p', 'p.id', 'img.postId')
          .select((eb) => [
            'r.id',
            eb.and([eb('p.id', 'is not', null), skillCheckLasting(eb as never)]).as('lasting'),
          ])
          .where('r.id', 'in', ids)
          .execute();
        const ineligible = checked.filter((c) => !c.lasting).map((c) => c.id);
        if (ineligible.length > 0) {
          await trx
            .updateTable('KnightsInquisitorReview')
            .set({ status: 'excluded', closedAt: utc(now), claimedBy: null, claimExpiresAt: null })
            .where('id', 'in', ineligible)
            .execute();
        }
        const keep = ids.filter((id) => !ineligible.includes(id));
        if (keep.length > 0) {
          await trx
            .updateTable('KnightsInquisitorReview')
            .set({ checkedAt: utc(now) })
            .where('id', 'in', keep)
            .execute();
        }
        return ineligible.length;
      }),
    0
  );
  for (let n = closed; n > 0; n--) metrics.reviewClosed('excluded');
  return closed;
}

/** Reviews the backlog cap expires at most per run. */
export const EXPIRE_LIMIT = 1_000;

/**
 * The cap's candidates: the oldest open reviews no moderator voted on, `excess` at most, row locked with SKIP LOCKED so a
 * review a vote holds is passed over. Exported for its test.
 */
export const expireCandidates = (db: Executor, excess: number) =>
  db
    .selectFrom('KnightsInquisitorReview as r')
    .select('r.id')
    .where('r.status', '=', 'open')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('KnightsInquisitorVote as v')
            .select(sql<number>`1`.as('one'))
            .whereRef('v.reviewId', '=', 'r.id')
        )
      )
    )
    .orderBy('r.createdAt', 'asc')
    .orderBy('r.id', 'asc')
    .limit(excess)
    .forUpdate()
    .skipLocked();

/**
 * Keeps the open backlog at `maxOpen` (`inquisitorMaxOpen`): the oldest open reviews no moderator voted on beyond it are
 * closed `expired`, at most `limit` per run. A review with a vote is never expired: the update repeats the check under
 * the candidates' row locks. Run by the tick. Returns how many.
 */
export async function expireBeyondCap(
  db: Kysely<DB>,
  { now, maxOpen, limit = EXPIRE_LIMIT }: { now: Date; maxOpen: number; limit?: number }
): Promise<number> {
  const { n } = await db
    .selectFrom('KnightsInquisitorReview')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('status', '=', 'open')
    .executeTakeFirstOrThrow();
  const excess = Math.min(Number(n) - maxOpen, limit);
  if (excess <= 0) return 0;
  const expired = await db.transaction().execute(async (trx) => {
    const ids = (await expireCandidates(trx, excess).execute()).map((r) => r.id);
    if (ids.length === 0) return 0;
    const result = await trx
      .updateTable('KnightsInquisitorReview')
      .set({ status: 'expired', closedAt: utc(now), claimedBy: null, claimExpiresAt: null })
      .where('id', 'in', ids)
      .where('status', '=', 'open')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('KnightsInquisitorVote as v')
              .select(sql<number>`1`.as('one'))
              .whereRef('v.reviewId', '=', 'KnightsInquisitorReview.id')
          )
        )
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  });
  for (let k = expired; k > 0; k--) metrics.reviewClosed('expired');
  return expired;
}

/**
 * The next review for this moderator: one another moderator already voted on first, then the oldest, each read as one
 * bounded batch in `(status, createdAt)` order of reviews on images that pass the safety exclusions now. A candidate the
 * per-image checks rule out for good is closed `excluded` on the way. `unreadable`: the safety exclusions could not be read
 * (fail closed: nothing is served).
 */
export async function nextReview(
  db: Kysely<DB>,
  { moderatorId, now = new Date() }: { moderatorId: number; now?: Date }
): Promise<ReviewOffer | 'unreadable' | null> {
  const unreadable = 'unreadable' as const;
  const served = await failClosed<ReviewOffer | typeof unreadable | null>(
    db,
    'review-serve',
    async () => {
      for (const voted of [true, false]) {
        const batch = await withoutJit(db, (q) =>
          servableReviews(q, moderatorId, now)
            .$call(hasVote(voted))
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
            // Reviews with a vote are few and finish a pair: oldest first. Unvoted ones newest first, so moderators see recent
            // images; the backlog cap expires the oldest.
            .orderBy('r.createdAt', voted ? 'asc' : 'desc')
            .orderBy('r.id', voted ? 'asc' : 'desc')
            .limit(SERVE_BATCH_PER_QUEUE)
            .execute()
        );
        for (const row of batch) {
          const exclusion = await exclusionOf(db, row);
          if (exclusion === 'unreadable') return unreadable;
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
          } satisfies ReviewOffer;
        }
      }
      return null;
    },
    unreadable
  );
  return served;
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
  /**
   * `confirmed-no-check`: the agreed level was written and the review confirmed, but at that level the image cannot be a
   * check. `written-not-closed`: the agreed level reached the image, but the review could not be closed and no check was
   * added.
   */
  | {
      status:
        | 'recorded'
        | 'confirmed'
        | 'confirmed-no-check'
        | 'split'
        | 'excluded'
        | 'written-not-closed';
    }
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
  if (
    second.kind === 'done' &&
    (second.result.status === 'confirmed' || second.result.status === 'confirmed-no-check')
  ) {
    return second.result;
  }
  // The level is the closing moderator's ruling now: keep their vote on record even though the review stays as it was.
  await db
    .insertInto('KnightsInquisitorVote')
    .values({
      reviewId: input.reviewId,
      moderatorId: input.moderatorId,
      answer: input.answer,
      createdAt: utc(deps.now()),
    })
    .onConflict((oc) => oc.columns(['reviewId', 'moderatorId']).doNothing())
    .execute()
    .catch((error) =>
      console.error('knights: could not record the vote behind a written level', {
        reviewId: input.reviewId,
        error,
      })
    );
  console.error("knights: the moderators' level was written but the review was not closed", {
    reviewId: input.reviewId,
    moderatorId: input.moderatorId,
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
  // The moderators' written level stands even when it keeps the image out of the pool: confirm without a check.
  if (pooled === 'ineligible' && overrideWritten) {
    await closeReview(trx, review.id, 'confirmed', now, input.answer);
    return done({ status: 'confirmed-no-check' });
  }
  // Otherwise an image the pool cannot take now (held, or its checks unreadable) rolls the vote back for a retry.
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
