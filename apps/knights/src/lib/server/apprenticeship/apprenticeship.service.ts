import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { getLevelProgression } from '../progression/levels';
import { grantAcolyteLevelGold } from './level-gold';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_SOURCE, servableImage } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import { metrics } from '../metrics';
import { grantRankBadges } from '../progression/badges';
import { mirrorXp, type XpMirror } from '../progression/legacy-exp';
import type { QuestionOption } from '../queue/queue.service';
import { servableReferences } from '../reference';
import { YESNO_ANSWERS } from '../yesno/keys';
import { answerImageJoin, answerQuestionKey, pairPrompt } from './answer-snapshot';
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
  /** The pair's `updatedAt` as served; an answer is refused if a moderator changed the pair since. Null for a rating. */
  version: string | null;
  options: QuestionOption[];
  imageKey: string;
  width: number | null;
  height: number | null;
};

type NextItem = ApprenticeItem & { correctAnswer: string; imageId: number };

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
  /** The answer's own id: its reference may have been deleted since. */
  answerId: number;
  /** Null when the image is no longer one the feeds would serve. */
  imageKey: string | null;
  width: number | null;
  height: number | null;
  answerLabel: string;
  correctLabel: string;
  explanation: string | null;
};

export type Checkpoint = {
  total: number;
  right: number;
  missed: CheckpointMiss[];
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
  | { status: 'recorded'; correct: boolean; xp: number; gold: number; promoted: boolean };

/** Rows of `KnightsApprenticeAnswer` for one player since their last career reset. */
const answersOf = (db: Executor, playerId: number) =>
  db
    .selectFrom('KnightsApprenticeAnswer as a')
    .where('a.playerId', '=', playerId)
    .where(
      sql<SqlBool>`a."createdAt" >= COALESCE((SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = a."playerId"), 'epoch')`
    );

export async function getApprenticeProgress(db: Executor, playerId: number) {
  return progressOf(db, playerId);
}

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

/**
 * Keyed on the image and question, not the reference row: a deleted and re-added reference must not re-serve an
 * answered image. The reference-id arm covers answers stored before the snapshot columns existed.
 */
const seenBy = (
  playerId: number,
  column: 'referenceId' | 'yesNoReferenceId',
  refs: { id: string; imageId: string; questionKey: string }
) =>
  sql<SqlBool>`NOT EXISTS (SELECT 1 FROM "KnightsApprenticeAnswer" s WHERE s."playerId" = ${playerId} AND (
    (s."imageId" = ${sql.ref(refs.imageId)} AND s."questionKey" = ${sql.ref(refs.questionKey)})
    OR s.${sql.ref(column)} = ${sql.ref(refs.id)}
  ))`;

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
    .where(
      seenBy(playerId, 'referenceId', {
        id: 'r.id',
        imageId: 'r.imageId',
        questionKey: 'r.questionKey',
      })
    )
    .select(['r.id', 'r.imageId', 'r.answer', 'img.url as imageKey', 'img.width', 'img.height'])
    .orderBy(shuffled(playerId, 'r.id'))
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    kind: 'rating',
    referenceId: row.id,
    imageId: row.imageId,
    questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
    ...(await ratingOptions(db)),
    version: null,
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
    .where(
      seenBy(playerId, 'yesNoReferenceId', {
        id: 'y.id',
        imageId: 'y.imageId',
        questionKey: 'y.questionKey',
      })
    )
    .select([
      'y.id',
      'y.imageId',
      'y.answer',
      'y.questionKey',
      pairPrompt.as('prompt'),
      sql<string>`y."updatedAt"::text`.as('version'),
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
    imageId: row.imageId,
    questionKey: row.questionKey,
    prompt: row.prompt,
    version: row.version,
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
    .leftJoin('Image as img', (join) => join.on(answerImageJoin))
    .leftJoin('Post as p', 'p.id', 'img.postId')
    .select((eb) => [
      'a.id',
      answerQuestionKey.as('questionKey'),
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
      const rating = row.questionKey === KNIGHTS_NSFW_LEVEL_QUESTION;
      const labels = rating ? options : YESNO_ANSWERS.map((a) => ({ ...a }));
      return {
        kind: rating ? 'rating' : 'yesno',
        answerId: row.id,
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
  const { correctAnswer: _hidden, imageId: _image, ...item } = next;
  return { kind: 'question', item, progress };
}

export async function answerApprentice(
  db: Kysely<DB>,
  input: {
    userId: number;
    kind: ItemKind;
    referenceId: number;
    /** The `version` the item was served with. Required for a yes/no pair, ignored for a rating. */
    version?: string | null;
    answer: string;
  },
  deps: ApprenticeDeps
): Promise<AnswerResult> {
  const { userId, kind, referenceId, version, answer } = input;
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

    let correctAnswer = current.correctAnswer;
    if (kind === 'yesno') {
      // Lock the pair so a moderator edit cannot commit between this read and the insert.
      const pair = await trx
        .selectFrom('KnightsYesNoReference')
        .select(['answer', 'active', sql<string>`"updatedAt"::text`.as('version')])
        .where('id', '=', referenceId)
        .forUpdate()
        .executeTakeFirst();
      if (!pair || !pair.active || !version || pair.version !== version) {
        return { status: 'rejected', reason: 'not-current' };
      }
      correctAnswer = pair.answer ? 'yes' : 'no';
    }

    const correct = answer === correctAnswer;
    const xp = correct ? APPRENTICE.xpPerCorrect : 0;
    await trx
      .insertInto('KnightsApprenticeAnswer')
      .values({
        playerId: userId,
        imageId: current.imageId,
        questionKey: current.questionKey,
        referenceId: kind === 'rating' ? referenceId : null,
        yesNoReferenceId: kind === 'yesno' ? referenceId : null,
        answer,
        correctAnswer,
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
    let gold = 0;
    if (xp > 0) {
      await trx.updateTable('NewOrderPlayer').set({ exp }).where('userId', '=', userId).execute();
      gold = await grantAcolyteLevelGold(trx, {
        playerId: userId,
        before: getLevelProgression(player.exp).level,
        after: getLevelProgression(exp).level,
        now,
      });
    }
    const after = await progressOf(trx, userId);
    const promoted = earnsKnighthood({
      level: getLevelProgression(exp).level,
      correct: after.correct,
      graded: after.graded,
    });
    if (promoted) await promoteToKnight(trx, userId);
    return { status: 'recorded', correct, xp, gold, promoted };
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
  if (!promoted) return;
  await grantRankBadges(db, userId, 'Knight');
  metrics.rankUp('Knight', userId);
}
