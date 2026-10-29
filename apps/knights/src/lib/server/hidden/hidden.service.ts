import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { servableImage } from '../servable-image';
import { canVote } from '../queue/ranks';
import { isRank } from '../ranks';
import { activeSmiteCount, issueSmite, resetNow, type ResetDeps } from '../smites/smites.service';
import { SMITES } from '../smites/config';
import { HIDDEN_CHECKS } from './config';

type Executor = Kysely<DB> | Transaction<DB>;
type Option = { value: string; label: string };

export type HiddenCheckOffer = {
  referenceId: number;
  question: { key: string; kind: string; prompt: string; options: Option[] };
  imageKey: string;
  width: number | null;
  height: number | null;
};

/** Which smite consequence an answer had. `reset` means the career was reset on the spot. */
export type Consequence = 'none' | 'warning' | 'smite' | 'reset';

export type HiddenCheckResult =
  | {
      status: 'rejected';
      reason: 'no-player' | 'not-eligible' | 'unavailable' | 'bad-answer' | 'already-answered';
    }
  | {
      status: 'graded';
      correct: boolean;
      correctLabel: string;
      imageKey: string;
      consequence: Consequence;
      activeSmites: number;
    };

async function slotOf(db: Executor, userId: number): Promise<number> {
  const [vote, hidden] = await Promise.all([
    db
      .selectFrom('KnightsVote')
      .select('createdAt')
      .where('playerId', '=', userId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('KnightsHiddenCheckAnswer')
      .select('createdAt')
      .where('playerId', '=', userId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);
  return Math.max(vote?.createdAt.getTime() ?? 0, hidden?.createdAt.getTime() ?? 0);
}

const unit = (digest: Buffer, at: number) => digest.readUInt32BE(at) / 2 ** 32;

function eligibleReferences(db: Executor, userId: number) {
  return db
    .selectFrom('KnightsReferenceImage as r')
    .innerJoin('Image as img', 'img.id', 'r.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
    .where('r.pool', '=', 'hiddenCheck')
    .where('r.status', '=', 'active')
    .where('q.active', '=', true)
    .where(servableImage)
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

/** The hidden check for this feed slot, or null for a queue item. */
export async function pickHiddenCheck(
  db: Executor,
  {
    userId,
    rank,
    secret,
    rate = HIDDEN_CHECKS.rate,
  }: { userId: number; rank: string; secret: string; rate?: number }
): Promise<HiddenCheckOffer | null> {
  if (!isRank(rank) || !canVote(rank, 'Knight')) return null;
  const digest = createHash('sha256')
    .update(`${secret}:hidden:${userId}:${await slotOf(db, userId)}`)
    .digest();
  if (unit(digest, 0) >= rate) return null;

  const count = await eligibleReferences(db, userId)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  const total = Number(count.n);
  if (total === 0) return null;

  const row = await eligibleReferences(db, userId)
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
    .offset(Math.floor(unit(digest, 4) * total))
    .executeTakeFirst();
  if (!row) return null;
  return {
    referenceId: row.id,
    question: {
      key: row.key,
      kind: row.kind,
      prompt: row.prompt,
      options: row.options as Option[],
    },
    imageKey: row.url,
    width: row.width,
    height: row.height,
  };
}

/** Levels are bit flags, so the distance is the gap between their bit positions. */
export const levelDistance = (a: number, b: number) => Math.abs(Math.log2(a) - Math.log2(b));

export const isSevereUnderRating = (given: string, known: string) => {
  const [g, k] = [Number(given), Number(known)];
  return g > 0 && k > 0 && g < k && levelDistance(g, k) >= HIDDEN_CHECKS.severeUnderRatingDistance;
};

const SMITE_REASON_SEVERE =
  'You severely under-rated a sanity check image. A smite penalty has been applied.';
const SMITE_REASON_REPEAT =
  'You failed a sanity check. A smite penalty has been applied, reducing your vote weight.';

/** Grades a hidden check at once. It touches no queue item, vote, gold or XP. */
export async function answerHiddenCheck(
  db: Kysely<DB>,
  input: { userId: number; referenceId: number; answer: string },
  deps: ResetDeps & { now: () => Date }
): Promise<HiddenCheckResult> {
  const now = deps.now();
  const outcome = await db
    .transaction()
    .execute(async (trx): Promise<HiddenCheckResult & { resetDue?: boolean }> => {
      const player = await trx
        .selectFrom('NewOrderPlayer')
        .select('rankType')
        .where('userId', '=', input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!player) return { status: 'rejected', reason: 'no-player' };
      if (!isRank(player.rankType) || !canVote(player.rankType, 'Knight')) {
        return { status: 'rejected', reason: 'not-eligible' };
      }

      const ref = await trx
        .selectFrom('KnightsReferenceImage as r')
        .innerJoin('Image as img', 'img.id', 'r.imageId')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
        .select(['r.id', 'r.imageId', 'r.answer', 'q.options', 'img.url'])
        .where('r.id', '=', input.referenceId)
        .where('r.pool', '=', 'hiddenCheck')
        .where('r.status', '=', 'active')
        .where(servableImage)
        .executeTakeFirst();
      if (!ref) return { status: 'rejected', reason: 'unavailable' };

      const options = ref.options as Option[];
      if (!options.some((o) => o.value === input.answer)) {
        return { status: 'rejected', reason: 'bad-answer' };
      }

      const correct = input.answer === ref.answer;
      const recorded = await trx
        .insertInto('KnightsHiddenCheckAnswer')
        .values({
          playerId: input.userId,
          referenceId: ref.id,
          imageId: ref.imageId,
          answer: input.answer,
          correct,
          createdAt: utc(now),
        })
        .onConflict((oc) => oc.columns(['playerId', 'referenceId']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!recorded) return { status: 'rejected', reason: 'already-answered' };

      await trx
        .updateTable('KnightsReferenceImage')
        .set({
          answers: sql<number>`"answers" + 1`,
          failures: sql<number>`"failures" + ${correct ? 0 : 1}`,
        })
        .where('id', '=', ref.id)
        .execute();

      const correctLabel = options.find((o) => o.value === ref.answer)?.label ?? ref.answer;
      const graded = { status: 'graded' as const, correct, correctLabel, imageKey: ref.url };
      if (correct) {
        const active = await activeSmiteCount(trx, input.userId);
        return { ...graded, consequence: 'none', activeSmites: active };
      }

      const windowStart = new Date(now.getTime() - HIDDEN_CHECKS.failureWindowHours * 3_600_000);
      const failures = await trx
        .selectFrom('KnightsHiddenCheckAnswer')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('playerId', '=', input.userId)
        .where('correct', '=', false)
        .where('createdAt', '>=', utc(windowStart))
        .executeTakeFirstOrThrow();
      const severe = isSevereUnderRating(input.answer, ref.answer);
      if (Number(failures.n) <= 1 && !severe) {
        return {
          ...graded,
          consequence: 'warning',
          activeSmites: await activeSmiteCount(trx, input.userId),
        };
      }

      const active = await issueSmite(trx, {
        playerId: input.userId,
        reason: severe ? SMITE_REASON_SEVERE : SMITE_REASON_REPEAT,
        now,
      });
      return {
        ...graded,
        consequence: 'smite',
        activeSmites: active,
        resetDue: active >= SMITES.max,
      };
    });

  if (outcome.status !== 'graded' || !outcome.resetDue) return stripFlag(outcome);
  const reset = await resetNow(input.userId, deps);
  return {
    ...stripFlag(outcome),
    ...(reset ? { consequence: 'reset' as const, activeSmites: 0 } : {}),
  } as HiddenCheckResult;
}

function stripFlag(outcome: HiddenCheckResult & { resetDue?: boolean }): HiddenCheckResult {
  const { resetDue: _due, ...rest } = outcome;
  return rest as HiddenCheckResult;
}
