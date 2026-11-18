import { createHash } from 'node:crypto';
import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { REFERENCE_POOL, REFERENCE_STATUS, servableImage } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { mirrorXp, type XpDelta, type XpMirror } from '../progression/legacy-exp';
import { metrics } from '../metrics';
import { PROGRESSION } from '../progression/config';
import { payOutVotes } from '../progression/progression';
import { BUCKET_LEVELS } from '../queue/feed';
import { canVote } from '../queue/ranks';
import {
  pacingGate,
  type CastVoteResult,
  type QuestionOption,
  type QueueDeps,
} from '../queue/queue.service';
import { BLOCKED_ANSWER } from '../../block-reasons';
import { creditVote, insertVote } from '../queue/vote-record';
import { isRank } from '../ranks';
import { servableReferences, type ServedStatus } from '../reference';
import { activeSmiteCount, resetNow, type ResetDeps } from '../smites/smites.service';
import type { HiddenCheckSettings } from './config';
import { gradeHiddenVotes, type CheckOutcome } from './settle';
import { closeNotice, SMITE_NOTICE, warningNotice, type Notice } from './notices';

type Executor = Kysely<DB> | Transaction<DB>;

export type HiddenCheckOffer = {
  referenceId: number;
  question: { key: string; kind: string; prompt: string; options: QuestionOption[] };
  imageKey: string;
  width: number | null;
  height: number | null;
};

/** What the player is told about a check graded in the request that answered it. */
export type CheckFeedback = {
  verdict: CheckOutcome['verdict'];
  consequence: CheckOutcome['consequence'];
  /** Active smites after this check. */
  smites: number;
  /** The check landed the smite that resets the career. */
  reset: boolean;
};

/** A vote's answers; a check graded on the spot also carries `check`. */
export type HiddenCheckResult =
  | Exclude<CastVoteResult, { status: 'resolved' | 'escalated' | 'inquisitor' | 'recorded' }>
  | { status: 'recorded'; check?: CheckFeedback };

/** A hidden check sits in the vote ledger under the negative of its reference image's id. */
export const hiddenItemId = (referenceId: number) => -referenceId;

/** Fixed per player until they answer something. */
export async function slotOf(db: Executor, userId: number): Promise<number> {
  const { rows } = await sql<{ slot: Date | null }>`
    SELECT max("createdAt") AS slot FROM "KnightsVote" WHERE "playerId" = ${userId}`.execute(db);
  const slot = rows[0]?.slot;
  return slot ? new Date(slot).getTime() : 0;
}

export const unit = (digest: Buffer, at: number) => digest.readUInt32BE(at) / 2 ** 32;

/** A reference's level bucket is its `answer`; `null` is every other answer, kept as a group of its own. */
type AnswerGroup = string | null;
const BUCKET_ANSWERS = BUCKET_LEVELS.map(String);
const ANSWER_GROUPS: AnswerGroup[] = [...BUCKET_ANSWERS, null];
/** Digest bytes 0-7 roll the rate and the start point; the bucket order reads the next four bytes per group. */
const BUCKET_DIGEST_OFFSET = 8;

/** The groups in a per-digest order, uniform over all orders, so the first group with a reference is a fair draw. */
const bucketOrder = (digest: Buffer) =>
  ANSWER_GROUPS.map((group, i) => ({ group, key: unit(digest, BUCKET_DIGEST_OFFSET + 4 * i) }))
    .sort((a, b) => a.key - b.key)
    .map(({ group }) => group);

function eligibleReferences(
  db: Executor,
  userId: number,
  questionKey: string,
  statuses: ServedStatus[],
  exclude: number[] = []
) {
  return servableReferences(db, REFERENCE_POOL.hiddenCheck, statuses)
    .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
    .where('r.questionKey', '=', questionKey)
    .where('q.active', '=', true)
    .$if(exclude.length > 0, (qb) => qb.where('r.id', 'not in', exclude))
    .where((eb) =>
      eb.not(
        eb.exists(
          // A check is a vote on its reference's image, so (player, image) is the whole test and rides the
          // ("playerId","imageId") index. It also keeps a probation check from the players whose votes made it.
          eb
            .selectFrom('KnightsVote as v')
            .select(sql<number>`1`.as('one'))
            .where('v.playerId', '=', userId)
            .whereRef('v.imageId', '=', 'r.imageId')
        )
      )
    );
}

/**
 * The hidden check for this feed slot, or null for a queue item. The pool is read on every call a Knight makes, so a page
 * costs the same whichever it turns out to be.
 *
 * The player's fixed digest orders the level buckets (a reference's `answer`; any other answer is a group of its own)
 * and picks a start point in the pool's id range (its lowest to highest id). The pick is the first eligible reference
 * at or after it (wrapping to the first one) in the first bucket, in that order, that has one: each bucket with an
 * eligible reference is equally likely, whatever its size, and the cost is a short index walk per bucket tried, not a
 * count of every eligible row.
 *
 * A share of 0 never serves probation, not even as a fallback.
 */
export async function pickHiddenCheck(
  db: Executor,
  input: {
    userId: number;
    rank: string;
    secret: string;
    questionKey: string;
    rate: number;
    /** Share (0 to 1) of checks drawn from probation references first; unset is 0. */
    probationShare?: number;
    /** Reference ids the player has skipped. */
    exclude?: number[];
    /** Rolls for an item the player has not reached yet; unset, the roll is fixed by their last vote. */
    slot?: number;
  }
): Promise<HiddenCheckOffer | null> {
  if (!isRank(input.rank) || !canVote(input.rank, 'Knight')) return null;
  const seed = `${input.secret}:hidden:${input.userId}:${
    input.slot ?? (await slotOf(db, input.userId))
  }`;
  const digest = createHash('sha256').update(seed).digest();
  // Its own digest: the pool roll must not reuse bytes `digest` already spends.
  const poolRoll = unit(createHash('sha256').update(`${seed}:probation`).digest(), 0);
  const share = input.probationShare ?? 0;
  const pools: ServedStatus[] =
    share <= 0
      ? [REFERENCE_STATUS.active]
      : poolRoll < share
      ? [REFERENCE_STATUS.probation, REFERENCE_STATUS.active]
      : [REFERENCE_STATUS.active, REFERENCE_STATUS.probation];

  const { low, top } = await db
    .selectFrom('KnightsReferenceImage')
    .select((eb) => [
      eb.fn.min<number | null>('id').as('low'),
      eb.fn.max<number | null>('id').as('top'),
    ])
    .where('pool', '=', REFERENCE_POOL.hiddenCheck)
    .where('questionKey', '=', input.questionKey)
    .executeTakeFirstOrThrow();
  const first = low ?? 0;
  const start = first + Math.floor(unit(digest, 4) * ((top ?? 0) - first + 1));

  const columns = [
    'r.id',
    'q.key',
    'q.kind',
    'q.prompt',
    'q.options',
    'img.url',
    'img.width',
    'img.height',
  ] as const;
  const walk = (status: ServedStatus, answers: AnswerGroup, from: 'at-or-after' | 'before') =>
    eligibleReferences(db, input.userId, input.questionKey, [status], input.exclude)
      .where((eb) =>
        answers === null ? eb('r.answer', 'not in', BUCKET_ANSWERS) : eb('r.answer', '=', answers)
      )
      .select(columns)
      .where('r.id', from === 'at-or-after' ? '>=' : '<', start)
      .orderBy('r.id', 'asc')
      .limit(1)
      .executeTakeFirst();

  let row: Awaited<ReturnType<typeof walk>> = undefined;
  for (const status of pools) {
    for (const group of bucketOrder(digest)) {
      row = (await walk(status, group, 'at-or-after')) ?? (await walk(status, group, 'before'));
      if (row) break;
    }
    if (row) break;
  }

  if (!row || unit(digest, 0) >= input.rate) return null;
  return {
    referenceId: row.id,
    question: {
      key: row.key,
      kind: row.kind,
      prompt: row.prompt,
      options: row.options as QuestionOption[],
    },
    imageKey: row.url,
    width: row.width,
    height: row.height,
  };
}

/** Levels are bit flags, so the distance is the gap between their bit positions. */
export const levelDistance = (a: number, b: number) => Math.abs(Math.log2(a) - Math.log2(b));

/**
 * A rating one level from the known answer, on either side: graded inconclusive for the player (no payout, no penalty) but
 * still a miss on the reference image. Blocked is not a level here, so Blocked against the top level is a plain miss.
 */
export const isCloseAnswer = (given: string, known: string) => {
  const [g, k] = [Number(given), Number(known)];
  const blocked = Number(BLOCKED_ANSWER);
  return g > 0 && k > 0 && g < blocked && k < blocked && levelDistance(g, k) === 1;
};

export const isSevereUnderRating = (given: string, known: string, distance: number) => {
  const [g, k] = [Number(given), Number(known)];
  return g > 0 && k > 0 && g < k && levelDistance(g, k) >= distance;
};

/**
 * Takes a hidden check answer as an ordinary vote: the same ledger row, XP, pending gold, daily tally and pacing as a
 * queue vote. It has no queue item and no write-back. With `grade` it is graded in the same transaction (`gradeHiddenVotes`)
 * and the result says what it cost, so the player sees a warning or smite on the answer that caused it; without `grade`,
 * `settleHiddenChecks` grades it later.
 *
 * A probation reference grades nobody: its answer is settled inconclusive at once, so a later promotion cannot grade it,
 * and the result reads as any inconclusive check. Any status but active or probation is refused.
 */
export async function answerHiddenCheck(
  db: Kysely<DB>,
  input: {
    userId: number;
    referenceId: number;
    answer: string;
    blockReason?: string | null;
    isModerator?: boolean;
  },
  deps: Pick<QueueDeps, 'now' | 'voteLimits'> & {
    mirrorXp?: XpMirror;
    grade?: ResetDeps & { settings: HiddenCheckSettings };
  }
): Promise<HiddenCheckResult> {
  const now = deps.now();
  let graded: { outcome: CheckOutcome; xp: XpDelta[]; reset: boolean } | null = null;
  let ungraded = false;
  const result = await db.transaction().execute(async (trx): Promise<HiddenCheckResult> => {
    const until = await pacingGate(trx, input, now, deps);
    if (until) return { status: 'limited', until };

    const ref = await servableReferences(trx, REFERENCE_POOL.hiddenCheck, [
      REFERENCE_STATUS.active,
      REFERENCE_STATUS.probation,
    ])
      .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
      .select(['r.id', 'r.imageId', 'r.questionKey', 'r.status', 'q.options'])
      .where('r.id', '=', input.referenceId)
      .executeTakeFirst();
    if (!ref) return { status: 'rejected', reason: 'unavailable' };
    const probation = ref.status === REFERENCE_STATUS.probation;
    // Fail closed on any other status.
    if (!probation && ref.status !== REFERENCE_STATUS.active) {
      return { status: 'rejected', reason: 'unavailable' };
    }

    const itemId = hiddenItemId(ref.id);
    const vote = await insertVote(
      trx,
      {
        userId: input.userId,
        answer: input.answer,
        blockReason: input.blockReason,
        now,
        lockPlayer: true,
      },
      {
        itemId,
        questionKey: ref.questionKey,
        imageId: ref.imageId,
        stage: 'Knight',
        options: ref.options as QuestionOption[],
        labelled: true,
      }
    );
    if (vote.status === 'rejected') return { status: 'rejected', reason: vote.reason };

    await creditVote(trx, {
      userId: input.userId,
      itemId,
      now,
      player: vote.player,
      gold: vote.gold,
    });
    if (probation) {
      await settleUngraded(trx, { itemId, playerId: input.userId, now });
      if (deps.grade) {
        const smites = await activeSmiteCount(trx, input.userId);
        graded = {
          outcome: { playerId: input.userId, verdict: 'inconclusive', consequence: null, smites },
          xp: [],
          reset: false,
        };
        ungraded = true;
      }
      return { status: 'recorded' };
    }
    if (!deps.grade) return { status: 'recorded' };

    // Read back: `creditVote` may have clamped the stored gold to the day's cap.
    const due = await trx
      .selectFrom('KnightsVote')
      .select(['itemId', 'playerId', 'verdict', 'gold', 'createdAt', 'answer'])
      .where('itemId', '=', itemId)
      .where('playerId', '=', input.userId)
      .where('createdAt', '=', utc(now))
      .execute();
    const { outcomes, xp, resetFor } = await gradeHiddenVotes(trx, due, {
      now,
      settings: deps.grade.settings,
    });
    graded = { outcome: outcomes[0], xp, reset: resetFor.includes(input.userId) };
    return { status: 'recorded' };
  });

  if (result.status !== 'recorded') return result;
  await mirrorXp(deps.mirrorXp, [{ playerId: input.userId, xp: PROGRESSION.voteXp }]);
  if (!graded || !deps.grade) return result;

  const { outcome, xp, reset } = graded as { outcome: CheckOutcome; xp: XpDelta[]; reset: boolean };
  if (!ungraded) metrics.hiddenCheckGraded(outcome.verdict);
  await mirrorXp(deps.mirrorXp, xp);
  // A reset that fails here stays due: the tick retries it (`resetPendingPlayers`).
  if (reset) await resetNow(input.userId, deps.grade);
  return {
    status: 'recorded',
    check: {
      verdict: outcome.verdict,
      consequence: outcome.consequence,
      smites: outcome.smites,
      reset,
    },
  };
}

/** Settles a just-cast check vote as inconclusive: no verdict against its reference, no pay, its pending gold released. */
async function settleUngraded(
  trx: Transaction<DB>,
  { itemId, playerId, now }: { itemId: number; playerId: number; now: Date }
) {
  const votes = await trx
    .updateTable('KnightsVote')
    .set({ verdict: 'inconclusive' })
    .where('itemId', '=', itemId)
    .where('playerId', '=', playerId)
    .where('createdAt', '=', utc(now))
    .returning(['itemId', 'playerId', 'verdict', 'gold', 'createdAt'])
    .execute();
  await payOutVotes(trx, votes, now);
}

/** A warning or smite the player has not dismissed, naming the check that caused it. */
export type CheckNotice = Notice & {
  /** Unique per check: the vote's item id and time. */
  key: string;
  consequence: 'warning' | 'smite' | 'close';
  /** Null when the image is no longer one the public feeds would show. */
  imageKey: string | null;
  answerLabel: string;
  correctLabel: string | null;
};

const NOTICES_SHOWN = 5;

/**
 * What graded checks cost the player in this career that they have not dismissed yet, newest first, one per check so each
 * names its image and the answer it wanted. A career reset moves `startAt`, and a notice from before it belongs to the old
 * career. Reading changes nothing, so a preload cannot lose it.
 */
export async function readHiddenNotices(db: Executor, playerId: number): Promise<CheckNotice[]> {
  const rows = await db
    .selectFrom('KnightsVote as v')
    .leftJoin('KnightsReferenceImage as r', (join) => join.on(sql<SqlBool>`r.id = -v."itemId"`))
    .leftJoin('KnightsQuestion as q', 'q.key', 'v.questionKey')
    .leftJoin('Image as img', 'img.id', 'v.imageId')
    .leftJoin('Post as p', 'p.id', 'img.postId')
    .select((eb) => [
      'v.itemId',
      'v.createdAt',
      'v.consequence',
      'v.answer',
      'r.answer as correct',
      'q.options',
      'img.url as imageKey',
      servableImage(eb).as('servable'),
    ])
    .where('v.playerId', '=', playerId)
    .where('v.consequence', 'is not', null)
    .where('v.noticedAt', 'is', null)
    .where(
      sql<SqlBool>`v."createdAt" >= COALESCE((SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = v."playerId"), 'epoch')`
    )
    .orderBy('v.createdAt', 'desc')
    .limit(NOTICES_SHOWN)
    .execute();
  return rows.map((row) => {
    const options = (row.options ?? []) as QuestionOption[];
    const labelOf = (value: string) => options.find((o) => o.value === value)?.label ?? value;
    const consequence =
      row.consequence === 'smite' ? 'smite' : row.consequence === 'close' ? 'close' : 'warning';
    const answerLabel = labelOf(row.answer);
    const correctLabel = row.correct ? labelOf(row.correct) : null;
    return {
      ...(consequence === 'smite'
        ? SMITE_NOTICE
        : consequence === 'close'
        ? closeNotice(correctLabel)
        : warningNotice(correctLabel, answerLabel)),
      key: `${row.itemId}:${new Date(row.createdAt).getTime()}`,
      consequence,
      imageKey: row.servable && row.imageKey ? row.imageKey : null,
      answerLabel,
      correctLabel,
    };
  });
}

/** One notice the toast showed, as its `key` names it (`${itemId}:${createdAt ms}`). */
export type ShownNotice = { itemId: number; createdAt: Date };

const MAX_NOTICE_KEYS = 20;
const INT4_MAX = 2_147_483_647;

/** The posted keys of the notices a toast showed; malformed ones are skipped, and at most `MAX_NOTICE_KEYS` are read. */
export function parseNoticeKeys(keys: readonly string[]): ShownNotice[] {
  const shown: ShownNotice[] = [];
  for (const key of keys.slice(0, MAX_NOTICE_KEYS)) {
    const match = /^(-?\d{1,10}):(\d{1,15})$/.exec(key);
    if (!match) continue;
    const itemId = Number(match[1]);
    const createdAt = new Date(Number(match[2]));
    if (Math.abs(itemId) > INT4_MAX || Number.isNaN(createdAt.getTime())) continue;
    shown.push({ itemId, createdAt });
  }
  return shown;
}

/**
 * Marks the player's notices seen. Given the ones a toast showed, only those: a check graded after the toast was drawn
 * stays unseen for the next one. Without them (a page from before keys were sent), every unseen notice, as before.
 */
export async function dismissHiddenNotices(
  db: Executor,
  playerId: number,
  now: Date,
  shown?: ShownNotice[]
) {
  if (shown && shown.length === 0) return;
  let update = db
    .updateTable('KnightsVote')
    .set({ noticedAt: utc(now) })
    .where('playerId', '=', playerId)
    .where('consequence', 'is not', null)
    .where('noticedAt', 'is', null);
  if (shown) {
    // The key carries milliseconds; the column may hold finer, so it is compared at the key's precision.
    update = update.where((eb) =>
      eb.or(
        shown.map((notice) =>
          eb.and([
            eb('itemId', '=', notice.itemId),
            eb(sql`date_trunc('milliseconds', "createdAt")`, '=', utc(notice.createdAt)),
          ])
        )
      )
    );
  }
  await update.execute();
}
