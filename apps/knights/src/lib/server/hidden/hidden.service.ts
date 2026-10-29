import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { REFERENCE_POOL } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { mirrorXp, type XpMirror } from '../progression/legacy-exp';
import { PROGRESSION } from '../progression/config';
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
async function slotOf(db: Executor, userId: number): Promise<number> {
  const { rows } = await sql<{ slot: Date | null }>`
    SELECT max("createdAt") AS slot FROM "KnightsVote" WHERE "playerId" = ${userId}`.execute(db);
  const slot = rows[0]?.slot;
  return slot ? new Date(slot).getTime() : 0;
}

const unit = (digest: Buffer, at: number) => digest.readUInt32BE(at) / 2 ** 32;

function eligibleReferences(db: Executor, userId: number, questionKey: string) {
  return servableReferences(db, REFERENCE_POOL.hiddenCheck)
    .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
    .where('r.questionKey', '=', questionKey)
    .where('q.active', '=', true)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('KnightsVote as v')
            .select(sql<number>`1`.as('one'))
            .where('v.playerId', '=', userId)
            .where((vb) =>
              vb.or([
                vb('v.itemId', '=', sql<number>`-"r"."id"`),
                vb('v.imageId', '=', vb.ref('r.imageId')),
              ])
            )
        )
      )
    );
}

/**
 * The hidden check for this feed slot, or null for a queue item. The pool is read on every call a Knight makes, so a page
 * costs the same whichever it turns out to be.
 */
export async function pickHiddenCheck(
  db: Executor,
  input: { userId: number; rank: string; secret: string; questionKey: string; rate: number }
): Promise<HiddenCheckOffer | null> {
  if (!isRank(input.rank) || !canVote(input.rank, 'Knight')) return null;
  const digest = createHash('sha256')
    .update(`${input.secret}:hidden:${input.userId}:${await slotOf(db, input.userId)}`)
    .digest();

  const { n } = await eligibleReferences(db, input.userId, input.questionKey)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  const row = await eligibleReferences(db, input.userId, input.questionKey)
    .select([
      'r.id',
      'q.key',
      'q.kind',
      'q.prompt',
      'q.options',
      'img.url',
      'img.width',
      'img.height',
    ])
    .orderBy('r.id', 'asc')
    .limit(1)
    .offset(Math.floor(unit(digest, 4) * Number(n)))
    .executeTakeFirst();

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
  input: { userId: number; referenceId: number; answer: string; isModerator?: boolean },
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
      { userId: input.userId, answer: input.answer, now, lockPlayer: true },
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

/** What graded checks cost the player that they have not dismissed yet. Reading changes nothing, so a preload cannot lose it. */
export async function readHiddenNotices(db: Executor, playerId: number): Promise<Notice[]> {
  const rows = await db
    .selectFrom('KnightsVote')
    .select('consequence')
    .where('playerId', '=', playerId)
    .where('consequence', 'is not', null)
    .where('noticedAt', 'is', null)
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
