import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_SOURCE, servableImage } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import { grantRankBadges } from '../progression/badges';
import { mirrorXp, type XpMirror } from '../progression/legacy-exp';
import type { QuestionOption } from '../queue/queue.service';
import { servableReferences } from '../reference';
import { YESNO_ANSWERS } from '../yesno/keys';
import { APPRENTICE } from './config';
import {
  accuracyOf,
  chooseSource,
  earnsKnighthood,
  isCheckpoint,
  needsCoaching,
  type Source,
  type Window,
} from './standing';

type Executor = Kysely<DB> | Transaction<DB>;

export type ApprenticeDeps = { now: () => Date; mirrorXp?: XpMirror };

export type ItemKind = 'rating' | 'yesno';

/** Everything the player is given about an item. The right answer never leaves the server until a recap lists a miss. */
export type ApprenticeItem = {
  kind: ItemKind;
  /** The id in `KnightsReferenceImage` (rating) or `KnightsYesNoReference` (yesno). */
  referenceId: number;
  questionKey: string;
  prompt: string;
  options: QuestionOption[];
  imageKey: string;
  width: number | null;
  height: number | null;
};

type NextItem = ApprenticeItem & { correctAnswer: string };

export type ApprenticeProgress = {
  /** Answers since the player's last career reset. */
  answered: number;
  /** The answers the accuracy is read from: the latest `APPRENTICE.window`, or fewer. */
  graded: number;
  correct: number;
  accuracy: number | null;
};

export type CheckpointMiss = {
  kind: ItemKind;
  referenceId: number;
  /** Null when the image is no longer one the feeds would serve. */
  imageKey: string | null;
  width: number | null;
  height: number | null;
  answerLabel: string;
  correctLabel: string;
  explanation: string | null;
};

export type Checkpoint = {
  /** Both counts and the list come from the same answers. */
  total: number;
  right: number;
  missed: CheckpointMiss[];
  /** Offer the rating guide as help. */
  coach: boolean;
};

export type ApprenticeView =
  | { kind: 'not-acolyte' }
  | { kind: 'question'; item: ApprenticeItem; progress: ApprenticeProgress }
  | { kind: 'checkpoint'; checkpoint: Checkpoint; progress: ApprenticeProgress }
  | { kind: 'exhausted'; progress: ApprenticeProgress };

export type AnswerResult =
  | {
      status: 'rejected';
      reason: 'no-player' | 'not-acolyte' | 'checkpoint-pending' | 'not-current' | 'bad-answer';
    }
  | { status: 'recorded'; correct: boolean; xp: number; promoted: boolean };

/** Rows of `KnightsApprenticeAnswer` for one player since their last career reset. */
const answersOf = (db: Executor, playerId: number) =>
  db
    .selectFrom('KnightsApprenticeAnswer as a')
    .where('a.playerId', '=', playerId)
    .where(
      sql<SqlBool>`a."createdAt" >= COALESCE((SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = a."playerId"), 'epoch')`
    );

async function progressOf(db: Executor, playerId: number): Promise<ApprenticeProgress> {
  const answered = Number(
    (
      await answersOf(db, playerId)
        .select(sql<string>`count(*)`.as('n'))
        .executeTakeFirstOrThrow()
    ).n
  );
  const latest = answersOf(db, playerId)
    .select('a.correct')
    .orderBy('a.id', 'desc')
    .limit(APPRENTICE.window)
    .as('w');
  const totals = await db
    .selectFrom(latest)
    .select([
      sql<string>`count(*)`.as('graded'),
      sql<string>`count(*) filter (where w.correct)`.as('correct'),
    ])
    .executeTakeFirstOrThrow();
  const window: Window = { graded: Number(totals.graded), correct: Number(totals.correct) };
  return { answered, ...window, accuracy: accuracyOf(window) };
}

async function checkpointPending(db: Executor, playerId: number, answered: number) {
  if (!isCheckpoint(answered)) return false;
  const last = await answersOf(db, playerId)
    .select('a.checkpointSeenAt')
    .orderBy('a.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return !!last && last.checkpointSeenAt === null;
}

const seenBy = (playerId: number, column: 'referenceId' | 'yesNoReferenceId', idRef: string) =>
  sql<SqlBool>`NOT EXISTS (SELECT 1 FROM "KnightsApprenticeAnswer" s WHERE s."playerId" = ${playerId} AND s.${sql.ref(
    column
  )} = ${sql.ref(idRef)})`;

/** A stable per-player order, so reloading shows the same item and different players get different orders. */
const shuffled = (playerId: number, idRef: string) =>
  sql`md5(${sql.ref(idRef)}::text || ${String(playerId)})`;

async function ratingOptions(db: Executor): Promise<{ prompt: string; options: QuestionOption[] }> {
  const question = await db
    .selectFrom('KnightsQuestion')
    .select(['prompt', 'options'])
    .where('key', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .executeTakeFirstOrThrow();
  return { prompt: question.prompt, options: question.options as QuestionOption[] };
}

async function nextRating(db: Executor, playerId: number, core: boolean): Promise<NextItem | null> {
  const row = await servableReferences(db, REFERENCE_POOL.trials)
    .where('r.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .where('r.source', core ? '=' : '<>', REFERENCE_SOURCE.core)
    .where(seenBy(playerId, 'referenceId', 'r.id'))
    .select(['r.id', 'r.answer', 'img.url as imageKey', 'img.width', 'img.height'])
    .orderBy(shuffled(playerId, 'r.id'))
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    kind: 'rating',
    referenceId: row.id,
    questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
    ...(await ratingOptions(db)),
    imageKey: row.imageKey,
    width: row.width,
    height: row.height,
    correctAnswer: row.answer,
  };
}

async function nextYesNo(db: Executor, playerId: number): Promise<NextItem | null> {
  const row = await db
    .selectFrom('KnightsYesNoReference as y')
    .innerJoin('KnightsQuestion as q', 'q.key', 'y.questionKey')
    .innerJoin('Image as img', 'img.id', 'y.imageId')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .where('y.active', '=', true)
    .where('q.active', '=', true)
    .where('q.kind', '=', 'bool')
    .where(servableImage)
    .where(seenBy(playerId, 'yesNoReferenceId', 'y.id'))
    .select([
      'y.id',
      'y.answer',
      'y.questionKey',
      'q.prompt',
      'img.url as imageKey',
      'img.width',
      'img.height',
    ])
    .orderBy(shuffled(playerId, 'y.id'))
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    kind: 'yesno',
    referenceId: row.id,
    questionKey: row.questionKey,
    prompt: row.prompt,
    options: YESNO_ANSWERS.map((answer) => ({ ...answer })),
    imageKey: row.imageKey,
    width: row.width,
    height: row.height,
    correctAnswer: row.answer ? 'yes' : 'no',
  };
}

/** The item this player is on: the same one until it is answered. Null when nothing is left to show. */
async function findNext(db: Executor, playerId: number): Promise<NextItem | null> {
  const core = await nextRating(db, playerId, true);
  if (core) return core;
  const rating = await nextRating(db, playerId, false);
  const yesNo = await nextYesNo(db, playerId);
  const position = Number(
    (
      await db
        .selectFrom('KnightsApprenticeAnswer')
        .select(sql<string>`count(*)`.as('n'))
        .where('playerId', '=', playerId)
        .executeTakeFirstOrThrow()
    ).n
  );
  const source: Source | null = chooseSource({
    position,
    core: false,
    rating: !!rating,
    yesNo: !!yesNo,
  });
  return source === 'rating' ? rating : source === 'yesno' ? yesNo : null;
}

const labelOf = (options: QuestionOption[], value: string) =>
  options.find((o) => o.value === value)?.label ?? value;

async function buildCheckpoint(
  db: Executor,
  playerId: number,
  progress: ApprenticeProgress
): Promise<Checkpoint> {
  const rows = await answersOf(db, playerId)
    .leftJoin('KnightsReferenceImage as r', 'r.id', 'a.referenceId')
    .leftJoin('KnightsYesNoReference as y', 'y.id', 'a.yesNoReferenceId')
    .leftJoin('Image as img', (join) =>
      join.on((eb) => eb('img.id', '=', eb.fn.coalesce('r.imageId', 'y.imageId')))
    )
    .leftJoin('Post as p', 'p.id', 'img.postId')
    .select((eb) => [
      'a.id',
      'a.referenceId',
      'a.yesNoReferenceId',
      'a.answer',
      'a.correctAnswer',
      'a.correct',
      sql<string | null>`COALESCE(r."explanation", y."explanation")`.as('explanation'),
      'img.url as imageKey',
      'img.width',
      'img.height',
      servableImage(eb).as('servable'),
    ])
    .orderBy('a.id', 'desc')
    .limit(APPRENTICE.checkpointEvery)
    .execute();
  const { options } = await ratingOptions(db);
  const missed = rows
    .filter((row) => !row.correct)
    .reverse()
    .map((row): CheckpointMiss => {
      const rating = row.referenceId !== null;
      const labels = rating ? options : YESNO_ANSWERS.map((a) => ({ ...a }));
      return {
        kind: rating ? 'rating' : 'yesno',
        referenceId: (rating ? row.referenceId : row.yesNoReferenceId) as number,
        imageKey: row.servable ? row.imageKey : null,
        width: row.width,
        height: row.height,
        answerLabel: labelOf(labels, row.answer),
        correctLabel: labelOf(labels, row.correctAnswer),
        explanation: row.explanation,
      };
    });
  return {
    total: rows.length,
    right: rows.filter((row) => row.correct).length,
    missed,
    coach: needsCoaching(progress.answered, progress.accuracy),
  };
}

export async function getApprentice(db: Kysely<DB>, playerId: number): Promise<ApprenticeView> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select('rankType')
    .where('userId', '=', playerId)
    .executeTakeFirst();
  // A user with no row yet is an Acolyte-to-be and is served like one.
  if (player && player.rankType !== 'Acolyte') return { kind: 'not-acolyte' };

  const progress = await progressOf(db, playerId);
  if (await checkpointPending(db, playerId, progress.answered)) {
    return {
      kind: 'checkpoint',
      checkpoint: await buildCheckpoint(db, playerId, progress),
      progress,
    };
  }
  const next = await findNext(db, playerId);
  if (!next) return { kind: 'exhausted', progress };
  const { correctAnswer: _hidden, ...item } = next;
  return { kind: 'question', item, progress };
}

export async function answerApprentice(
  db: Kysely<DB>,
  input: { userId: number; kind: ItemKind; referenceId: number; answer: string },
  deps: ApprenticeDeps
): Promise<AnswerResult> {
  const { userId, kind, referenceId, answer } = input;
  const now = deps.now();

  const result = await db.transaction().execute(async (trx): Promise<AnswerResult> => {
    // The player row lock serialises one player's answers, so the item check below and the insert cannot interleave.
    const player = await trx
      .selectFrom('NewOrderPlayer')
      .select(['rankType', 'exp'])
      .where('userId', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!player) return { status: 'rejected', reason: 'no-player' };
    if (player.rankType !== 'Acolyte') return { status: 'rejected', reason: 'not-acolyte' };

    const before = await progressOf(trx, userId);
    if (await checkpointPending(trx, userId, before.answered)) {
      return { status: 'rejected', reason: 'checkpoint-pending' };
    }
    const current = await findNext(trx, userId);
    if (!current || current.kind !== kind || current.referenceId !== referenceId) {
      return { status: 'rejected', reason: 'not-current' };
    }
    if (!current.options.some((option) => option.value === answer)) {
      return { status: 'rejected', reason: 'bad-answer' };
    }

    const correct = answer === current.correctAnswer;
    const xp = correct ? APPRENTICE.xpPerCorrect : 0;
    await trx
      .insertInto('KnightsApprenticeAnswer')
      .values({
        playerId: userId,
        referenceId: kind === 'rating' ? referenceId : null,
        yesNoReferenceId: kind === 'yesno' ? referenceId : null,
        answer,
        correctAnswer: current.correctAnswer,
        correct,
        xp,
        createdAt: utc(now),
      })
      .execute();
    if (kind === 'rating') {
      await trx
        .updateTable('KnightsReferenceImage')
        .set({
          answers: sql`"answers" + 1`,
          failures: correct ? sql`"failures"` : sql`"failures" + 1`,
        })
        .where('id', '=', referenceId)
        .execute();
    }

    const exp = player.exp + xp;
    if (xp > 0) {
      await trx.updateTable('NewOrderPlayer').set({ exp }).where('userId', '=', userId).execute();
    }
    const after = await progressOf(trx, userId);
    const promoted = earnsKnighthood({
      level: getLevelProgression(exp).level,
      correct: after.correct,
      graded: after.graded,
    });
    if (promoted) await promoteToKnight(trx, userId);
    return { status: 'recorded', correct, xp, promoted };
  });

  if (result.status === 'recorded') {
    await mirrorXp(deps.mirrorXp, result.xp > 0 ? [{ playerId: userId, xp: result.xp }] : []);
  }
  return result;
}

/** Moves a player past the recap they are looking at. Safe to repeat; does nothing when no checkpoint is waiting. */
export async function acknowledgeCheckpoint(
  db: Kysely<DB>,
  playerId: number,
  now: Date
): Promise<void> {
  const progress = await progressOf(db, playerId);
  if (!(await checkpointPending(db, playerId, progress.answered))) return;
  const last = await answersOf(db, playerId)
    .select('a.id')
    .orderBy('a.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!last) return;
  await db
    .updateTable('KnightsApprenticeAnswer')
    .set({ checkpointSeenAt: utc(now) })
    .where('id', '=', last.id)
    .where('checkpointSeenAt', 'is', null)
    .execute();
}

/** Acolyte to Knight. Only ever applied to an Acolyte: a Knight or above is left as they are. */
export async function promoteToKnight(db: Executor, userId: number) {
  const promoted = await db
    .updateTable('NewOrderPlayer')
    .set({ rankType: 'Knight' })
    .where('userId', '=', userId)
    .where('rankType', '=', 'Acolyte')
    .returning('userId')
    .executeTakeFirst();
  if (promoted) await grantRankBadges(db, userId, 'Knight');
}
