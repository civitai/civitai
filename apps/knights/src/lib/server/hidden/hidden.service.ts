import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { REFERENCE_POOL } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { canVote } from '../queue/ranks';
import {
  pacingGate,
  type CastVoteResult,
  type RejectReason,
  type QuestionOption,
  type QueueDeps,
} from '../queue/queue.service';
import { isRank } from '../ranks';
import { servableReferences } from '../reference';
import { SMITES } from '../smites/config';
import { activeSmiteCount, issueSmite, resetNow, type ResetDeps } from '../smites/smites.service';
import type { HiddenCheckSettings } from './config';
import { SMITE_NOTICE, SMITE_REASON, WARNING_NOTICE, type Notice } from './notices';

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

type HiddenDeps = ResetDeps &
  Pick<QueueDeps, 'now' | 'voteLimits'> & { settings: HiddenCheckSettings };

/** Fixed per player until they answer something. */
async function slotOf(db: Executor, userId: number): Promise<number> {
  const { rows } = await sql<{ slot: Date | null }>`
    SELECT GREATEST(
      (SELECT max("createdAt") FROM "KnightsVote" WHERE "playerId" = ${userId}),
      (SELECT max("createdAt") FROM "KnightsHiddenCheckAnswer" WHERE "playerId" = ${userId})
    ) AS slot`.execute(db);
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
            .selectFrom('KnightsHiddenCheckAnswer as a')
            .select(sql<number>`1`.as('one'))
            .whereRef('a.referenceId', '=', 'r.id')
            .where('a.playerId', '=', userId)
        )
      )
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('KnightsVote as v')
            .select(sql<number>`1`.as('one'))
            .whereRef('v.imageId', '=', 'r.imageId')
            .where('v.playerId', '=', userId)
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

type Outcome = { result: HiddenCheckResult; resetDue: boolean };

/**
 * Takes a hidden check answer. It answers exactly as a vote does and touches no queue item, vote, gold or XP; what it
 * cost the player is stored on the answer and shown by `takeHiddenNotices`.
 */
export async function answerHiddenCheck(
  db: Kysely<DB>,
  input: { userId: number; referenceId: number; answer: string; isModerator?: boolean },
  deps: HiddenDeps
): Promise<HiddenCheckResult> {
  const now = deps.now();
  const { result, resetDue } = await db.transaction().execute(async (trx): Promise<Outcome> => {
    const rejected = (reason: RejectReason) => ({
      result: { status: 'rejected', reason } as const,
      resetDue: false,
    });

    const until = await pacingGate(trx, input, now, deps);
    if (until) return { result: { status: 'limited', until }, resetDue: false };

    const player = await trx
      .selectFrom('NewOrderPlayer')
      .select(['rankType', 'startAt'])
      .where('userId', '=', input.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!player) return rejected('no-player');
    if (!isRank(player.rankType) || !canVote(player.rankType, 'Knight')) {
      return rejected('not-eligible');
    }

    const ref = await servableReferences(trx, REFERENCE_POOL.hiddenCheck)
      .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
      .select(['r.id', 'r.imageId', 'r.answer', 'q.options'])
      .where('r.id', '=', input.referenceId)
      .executeTakeFirst();
    if (!ref) return rejected('unavailable');
    if (!(ref.options as QuestionOption[]).some((o) => o.value === input.answer)) {
      return rejected('bad-answer');
    }
    if ((await activeSmiteCount(trx, input.userId)) >= SMITES.max) return rejected('reset-pending');

    const correct = input.answer === ref.answer;
    // Failures from before the last career reset were wiped with it.
    const since = new Date(
      Math.max(
        now.getTime() - deps.settings.failureWindowHours * 3_600_000,
        player.startAt.getTime()
      )
    );
    const earlier = correct
      ? 0
      : Number(
          (
            await trx
              .selectFrom('KnightsHiddenCheckAnswer')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .where('playerId', '=', input.userId)
              .where('correct', '=', false)
              .where('createdAt', '>=', utc(since))
              .executeTakeFirstOrThrow()
          ).n
        );
    const smites =
      !correct &&
      (earlier >= 1 || isSevereUnderRating(input.answer, ref.answer, deps.settings.severeDistance));

    const recorded = await trx
      .insertInto('KnightsHiddenCheckAnswer')
      .values({
        playerId: input.userId,
        referenceId: ref.id,
        imageId: ref.imageId,
        answer: input.answer,
        correct,
        consequence: correct ? null : smites ? 'smite' : 'warning',
        createdAt: utc(now),
      })
      .onConflict((oc) => oc.columns(['playerId', 'referenceId']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!recorded) return rejected('already-voted');

    await trx
      .updateTable('KnightsReferenceImage')
      .set({
        answers: sql<number>`"answers" + 1`,
        failures: sql<number>`"failures" + ${correct ? 0 : 1}`,
      })
      .where('id', '=', ref.id)
      .execute();

    if (!smites) return { result: { status: 'recorded' }, resetDue: false };
    const active = await issueSmite(trx, { playerId: input.userId, reason: SMITE_REASON, now });
    return { result: { status: 'recorded' }, resetDue: active >= SMITES.max };
  });

  if (resetDue) await resetNow(input.userId, deps);
  return result;
}

/** What the player's last answers cost them, once each: the old game's warning and smite messages. */
export async function takeHiddenNotices(
  db: Executor,
  playerId: number,
  now: Date
): Promise<Notice[]> {
  const rows = await db
    .updateTable('KnightsHiddenCheckAnswer')
    .set({ noticedAt: utc(now) })
    .where('playerId', '=', playerId)
    .where('consequence', 'is not', null)
    .where('noticedAt', 'is', null)
    .returning('consequence')
    .execute();
  const smited = rows.some((r) => r.consequence === 'smite');
  if (smited) return [SMITE_NOTICE];
  return rows.length > 0 ? [WARNING_NOTICE] : [];
}
