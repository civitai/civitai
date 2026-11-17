import { createHash } from 'node:crypto';
import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { REFERENCE_POOL } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { mirrorXp, type XpMirror } from '../progression/legacy-exp';
import { PROGRESSION } from '../progression/config';
import { BUCKET_LEVELS } from '../queue/feed';
import { canVote } from '../queue/ranks';
import {
  pacingGate,
  type CastVoteResult,
  type QuestionOption,
  type QueueDeps,
} from '../queue/queue.service';
import { creditVote, insertVote } from '../queue/vote-record';
import { isRank } from '../ranks';
import { servableReferences } from '../reference';
import { SMITE_NOTICE, WARNING_NOTICE, type Notice } from './notices';

type Executor = Kysely<DB> | Transaction<DB>;

export type HiddenCheckOffer = {
  referenceId: number;
  question: { key: string; kind: string; prompt: string; options: QuestionOption[] };
  imageKey: string;
  width: number | null;
  height: number | null;
};

/** The same answers a vote gets, so a check cannot be told apart by what comes back. */
export type HiddenCheckResult = Exclude<
  CastVoteResult,
  { status: 'resolved' | 'escalated' | 'inquisitor' }
>;

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
  exclude: number[] = []
) {
  return servableReferences(db, REFERENCE_POOL.hiddenCheck)
    .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
    .where('r.questionKey', '=', questionKey)
    .where('q.active', '=', true)
    .$if(exclude.length > 0, (qb) => qb.where('r.id', 'not in', exclude))
    .where((eb) =>
      eb.not(
        eb.exists(
          // A check is a vote on its reference's image, so (player, image) is the whole test and rides the
          // ("playerId","imageId") index.
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
 */
export async function pickHiddenCheck(
  db: Executor,
  input: {
    userId: number;
    rank: string;
    secret: string;
    questionKey: string;
    rate: number;
    /** Reference ids the player has skipped. */
    exclude?: number[];
    /** Rolls for an item the player has not reached yet; unset, the roll is fixed by their last vote. */
    slot?: number;
  }
): Promise<HiddenCheckOffer | null> {
  if (!isRank(input.rank) || !canVote(input.rank, 'Knight')) return null;
  const digest = createHash('sha256')
    .update(
      `${input.secret}:hidden:${input.userId}:${input.slot ?? (await slotOf(db, input.userId))}`
    )
    .digest();

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
  const walk = (answers: AnswerGroup, from: 'at-or-after' | 'before') =>
    eligibleReferences(db, input.userId, input.questionKey, input.exclude)
      .where((eb) =>
        answers === null ? eb('r.answer', 'not in', BUCKET_ANSWERS) : eb('r.answer', '=', answers)
      )
      .select(columns)
      .where('r.id', from === 'at-or-after' ? '>=' : '<', start)
      .orderBy('r.id', 'asc')
      .limit(1)
      .executeTakeFirst();

  let row: Awaited<ReturnType<typeof walk>> = undefined;
  for (const group of bucketOrder(digest)) {
    row = (await walk(group, 'at-or-after')) ?? (await walk(group, 'before'));
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

export const isSevereUnderRating = (given: string, known: string, distance: number) => {
  const [g, k] = [Number(given), Number(known)];
  return g > 0 && k > 0 && g < k && levelDistance(g, k) >= distance;
};

/**
 * Takes a hidden check answer as an ordinary vote: the same ledger row, XP, pending gold, daily tally and pacing as a
 * queue vote. It has no queue item and no write-back; `settleHiddenChecks` grades it later.
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
  deps: Pick<QueueDeps, 'now' | 'voteLimits'> & { mirrorXp?: XpMirror }
): Promise<HiddenCheckResult> {
  const now = deps.now();
  const result = await db.transaction().execute(async (trx): Promise<HiddenCheckResult> => {
    const until = await pacingGate(trx, input, now, deps);
    if (until) return { status: 'limited', until };

    const ref = await servableReferences(trx, REFERENCE_POOL.hiddenCheck)
      .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
      .select(['r.id', 'r.imageId', 'r.questionKey', 'q.options'])
      .where('r.id', '=', input.referenceId)
      .executeTakeFirst();
    if (!ref) return { status: 'rejected', reason: 'unavailable' };

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
    return { status: 'recorded' };
  });

  if (result.status === 'recorded') {
    await mirrorXp(deps.mirrorXp, [{ playerId: input.userId, xp: PROGRESSION.voteXp }]);
  }
  return result;
}

const noticeOf = (consequence: string): Notice =>
  consequence === 'smite' ? SMITE_NOTICE : WARNING_NOTICE;

/**
 * What graded checks cost the player in this career that they have not dismissed yet. A career reset moves
 * `startAt`, and a notice from before it belongs to the old career. Reading changes nothing, so a preload cannot lose it.
 */
export async function readHiddenNotices(db: Executor, playerId: number): Promise<Notice[]> {
  const rows = await db
    .selectFrom('KnightsVote')
    .select('consequence')
    .where('playerId', '=', playerId)
    .where('consequence', 'is not', null)
    .where('noticedAt', 'is', null)
    .where(
      sql<SqlBool>`"createdAt" >= COALESCE((SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = "KnightsVote"."playerId"), 'epoch')`
    )
    .execute();
  if (rows.length === 0) return [];
  return [noticeOf(rows.some((r) => r.consequence === 'smite') ? 'smite' : 'warning')];
}

export async function dismissHiddenNotices(db: Executor, playerId: number, now: Date) {
  await db
    .updateTable('KnightsVote')
    .set({ noticedAt: utc(now) })
    .where('playerId', '=', playerId)
    .where('consequence', 'is not', null)
    .where('noticedAt', 'is', null)
    .execute();
}
