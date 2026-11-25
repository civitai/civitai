import { createHash } from 'node:crypto';
import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { getLevelProgression } from '../progression/levels';
import { grantAcolyteLevelGold } from './level-gold';
import type { DB } from '@civitai/db-schema/kysely';
import { readWithoutJit, REFERENCE_POOL, REFERENCE_SOURCE } from '@civitai/db/knights';
import { servableImage } from '../image-gate';
import { utc } from '@civitai/db/kysely';
import { metrics } from '../metrics';
import { grantRankBadges } from '../progression/badges';
import { mirrorXp, type XpMirror } from '../progression/legacy-exp';
import type { QuestionOption } from '../queue/queue.service';
import { servableReferences } from '../reference';
import { answeredImageServable, failClosed } from '../skill-check/eligible';
import { ACOLYTE_WRONG_ANSWER_SMITE, BASE_SMITE_SIZE, SMITES } from '../smites/config';
import {
  activeSmiteCount,
  cleanseSmites,
  issueSmite,
  resetNow,
  type ResetDeps,
} from '../smites/smites.service';
import { YESNO_ANSWERS } from '../yesno/keys';
import { answerImageJoin, answerQuestionKey, pairPrompt } from './answer-snapshot';
import { APPRENTICE, type ApprenticeSettings } from './config';
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

export type ApprenticeDeps = {
  now: () => Date;
  mirrorXp?: XpMirror;
  /** Starts the career reset an answer's third smite makes due; without it the tick does. */
  resetPlayer?: ResetDeps['resetPlayer'];
  /** Without it, smites are on. */
  settings?: () => ApprenticeSettings | Promise<ApprenticeSettings>;
  /** Share of image slots that serve a mod-confirmed skill check; must match the `getApprentice` that served the item. */
  skillCheckRate?: number;
};

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
      reason:
        | 'no-player'
        | 'not-acolyte'
        | 'reset-pending'
        | 'checkpoint-pending'
        | 'not-current'
        | 'bad-answer';
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
  return (await standingOf(db, playerId)).progress;
}

/**
 * The player's progress, and whether a checkpoint recap waits for them, in one query.
 */
async function standingOf(
  db: Executor,
  playerId: number
): Promise<{ progress: ApprenticeProgress; checkpointPending: boolean }> {
  const latest = answersOf(db, playerId)
    .select('a.correct')
    .orderBy('a.id', 'desc')
    .limit(APPRENTICE.window)
    .as('w');
  const row = await db
    .selectFrom(latest)
    .select([
      answersOf(db, playerId)
        .select(sql<string>`count(*)`.as('n'))
        .as('answered'),
      answersOf(db, playerId)
        .select(sql<boolean>`a."checkpointSeenAt" IS NULL`.as('open'))
        .orderBy('a.id', 'desc')
        .limit(1)
        .as('lastOpen'),
      sql<string>`count(*)`.as('graded'),
      sql<string>`count(*) filter (where w.correct)`.as('correct'),
    ])
    .executeTakeFirstOrThrow();
  const answered = Number(row.answered);
  const window: Window = { graded: Number(row.graded), correct: Number(row.correct) };
  return {
    progress: { answered, ...window, accuracy: accuracyOf(window) },
    checkpointPending: isCheckpoint(answered) && row.lastOpen === true,
  };
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
  sql<SqlBool>`NOT EXISTS (SELECT 1 FROM "KnightsApprenticeAnswer" s WHERE s."playerId" = ${playerId}
    AND s."imageId" = ${sql.ref(refs.imageId)} AND s."questionKey" = ${sql.ref(refs.questionKey)})
  AND NOT EXISTS (SELECT 1 FROM "KnightsApprenticeAnswer" s WHERE s."playerId" = ${playerId}
    AND s.${sql.ref(column)} = ${sql.ref(refs.id)})${
    column === 'yesNoReferenceId'
      ? sql`
  AND NOT EXISTS (SELECT 1 FROM "KnightsUnsure" u WHERE u."playerId" = ${playerId}
    AND (u."yesNoReferenceId" = ${sql.ref(refs.id)}
      OR (u."imageId" = ${sql.ref(refs.imageId)} AND u."questionKey" = ${sql.ref(
          refs.questionKey
        )})))`
      : sql``
  }`;

/** Re-dealt after every answer, yet the same until then, so a reload cannot reroll the item on screen. */
const shuffled = (playerId: number, position: number, idRef: string) =>
  sql`md5(${sql.ref(idRef)}::text || ${`:${playerId}:${position}`})`;

async function ratingOptions(db: Executor): Promise<{ prompt: string; options: QuestionOption[] }> {
  const question = await db
    .selectFrom('KnightsQuestion')
    .select(['prompt', 'options'])
    .where('key', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .executeTakeFirstOrThrow();
  return { prompt: question.prompt, options: question.options as QuestionOption[] };
}

/** `core` and `harvested` are the trials pool split by source; `skill` is the mod-confirmed skill-check pool. */
type RatingSource = 'core' | 'harvested' | 'skill';

async function nextRating(
  db: Executor,
  playerId: number,
  position: number,
  from: RatingSource
): Promise<NextItem | null> {
  const [row, question] = await Promise.all([
    readWithoutJit(db, (trx) =>
      servableReferences(trx, [
        from === 'skill' ? REFERENCE_POOL.skillCheck : REFERENCE_POOL.trials,
      ])
        .where('r.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
        .$if(from !== 'skill', (qb) =>
          qb.where('r.source', from === 'core' ? '=' : '<>', REFERENCE_SOURCE.core)
        )
        .where(
          seenBy(playerId, 'referenceId', {
            id: 'r.id',
            imageId: 'r.imageId',
            questionKey: 'r.questionKey',
          })
        )
        .select(['r.id', 'r.imageId', 'r.answer', 'img.url as imageKey', 'img.width', 'img.height'])
        .orderBy(shuffled(playerId, position, 'r.id'))
        .limit(1)
        .executeTakeFirst()
    ),
    ratingOptions(db),
  ]);
  if (!row) return null;
  return {
    kind: 'rating',
    referenceId: row.id,
    imageId: row.imageId,
    questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
    ...question,
    version: null,
    imageKey: row.imageKey,
    width: row.width,
    height: row.height,
    correctAnswer: row.answer,
  };
}

async function nextYesNo(
  db: Executor,
  playerId: number,
  position: number
): Promise<NextItem | null> {
  const row = await readWithoutJit(db, (trx) =>
    trx
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
      .orderBy(shuffled(playerId, position, 'y.id'))
      .limit(1)
      .executeTakeFirst()
  );
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

/** A fixed roll per (player, position) in [0, 1): the same until the player answers, so a reload serves the same item. */
const skillRoll = (playerId: number, position: number) =>
  createHash('sha256').update(`${playerId}:${position}:skill-check`).digest().readUInt32BE(0) /
  0x1_0000_0000;

/**
 * The item this player is on: the same one until it is answered. Null when nothing is left to show. An image slot is a
 * mod-confirmed skill check at `skillCheckRate` (the Knights' skill-check rate), when one is left for the player.
 */
async function findNext(
  db: Executor,
  playerId: number,
  skillCheckRate = 0
): Promise<NextItem | null> {
  // Every answer the player ever gave, not just this career's: the no-repeat rule spans resets too. A "Not sure" on a
  // pair moves the stream on like an answer, so the next slot is not another yes/no.
  const position = Number(
    (
      await db
        .selectNoFrom((eb) =>
          sql<string>`(${eb
            .selectFrom('KnightsApprenticeAnswer')
            .select(sql<string>`count(*)`.as('n'))
            .where('playerId', '=', playerId)}) + (${eb
            .selectFrom('KnightsUnsure')
            .select(sql<string>`count(*)`.as('n'))
            .where('playerId', '=', playerId)
            .where('yesNoReferenceId', 'is not', null)})`.as('n')
        )
        .executeTakeFirstOrThrow()
    ).n
  );
  const [core, yesNo] = await Promise.all([
    nextRating(db, playerId, position, 'core'),
    nextYesNo(db, playerId, position),
  ]);
  const yesNoSlot = position % APPRENTICE.yesNoEvery === APPRENTICE.yesNoEvery - 1;
  if (
    skillCheckRate > 0 &&
    !(yesNoSlot && yesNo) &&
    skillRoll(playerId, position) < skillCheckRate
  ) {
    // The mod-confirmed pool's safety reads fail closed: unreadable, the slot serves another image.
    const skill = await failClosed(
      db,
      'acolyte-serve',
      () => nextRating(db, playerId, position, 'skill'),
      null
    );
    if (skill) return skill;
  }
  // Harvested references only once the player has answered every core one.
  const rating = core ? null : await nextRating(db, playerId, position, 'harvested');
  const source: Source | null = chooseSource({
    position,
    core: !!core,
    rating: !!rating,
    yesNo: !!yesNo,
  });
  return source === 'core'
    ? core
    : source === 'rating'
    ? rating
    : source === 'yesno'
    ? yesNo
    : null;
}

const labelOf = (options: QuestionOption[], value: string) =>
  options.find((o) => o.value === value)?.label ?? value;

async function buildCheckpoint(
  db: Executor,
  playerId: number,
  progress: ApprenticeProgress
): Promise<Checkpoint> {
  const rows = await readWithoutJit(db, async (trx) => {
    const read = (skillChecks: 'checked' | 'hidden') =>
      answersOf(trx, playerId)
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
          answeredImageServable(eb as never, skillChecks).as('servable'),
        ])
        .orderBy('a.id', 'desc')
        .limit(APPRENTICE.checkpointEvery)
        .execute();
    return (await failClosed(trx, 'recap', () => read('checked'), null)) ?? (await read('hidden'));
  });
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

export async function getApprentice(
  db: Kysely<DB>,
  playerId: number,
  { skillCheckRate = 0 }: { skillCheckRate?: number } = {}
): Promise<ApprenticeView> {
  const [player, { progress, checkpointPending }] = await Promise.all([
    db
      .selectFrom('NewOrderPlayer')
      .select('rankType')
      .where('userId', '=', playerId)
      .executeTakeFirst(),
    standingOf(db, playerId),
  ]);
  if (player && player.rankType !== 'Acolyte') return { kind: 'not-acolyte' };

  if (checkpointPending) {
    return {
      kind: 'checkpoint',
      checkpoint: await buildCheckpoint(db, playerId, progress),
      progress,
    };
  }
  const next = await findNext(db, playerId, skillCheckRate);
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
  const smites = (await deps.settings?.())?.smites ?? true;

  const result = await db.transaction().execute(async (trx): Promise<TxResult> => {
    // The player row lock serialises one player's answers, so the item check below and the insert cannot interleave.
    const player = await trx
      .selectFrom('NewOrderPlayer')
      .select(['rankType', 'exp'])
      .where('userId', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!player) return { status: 'rejected', reason: 'no-player' };
    if (player.rankType !== 'Acolyte') return { status: 'rejected', reason: 'not-acolyte' };
    if ((await activeSmiteCount(trx, userId)) >= SMITES.max) {
      return { status: 'rejected', reason: 'reset-pending' };
    }

    if ((await standingOf(trx, userId)).checkpointPending) {
      return { status: 'rejected', reason: 'checkpoint-pending' };
    }
    const current = await findNext(trx, userId, deps.skillCheckRate ?? 0);
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
      const levelBefore = getLevelProgression(player.exp).level;
      const levelAfter = getLevelProgression(exp).level;
      gold = await grantAcolyteLevelGold(trx, {
        playerId: userId,
        before: levelBefore,
        after: levelAfter,
        now,
      });
      if (levelAfter > levelBefore) {
        await cleanseSmites(trx, { playerId: userId, reason: LEVEL_UP_CLEANSE, now });
      }
    }
    let resetDue = false;
    if (smites && !correct && (await wrongSinceLastSmite(trx, userId)) >= APPRENTICE.smiteWrong) {
      const active = await issueSmite(trx, {
        playerId: userId,
        reason: ACOLYTE_WRONG_ANSWER_SMITE,
        size: BASE_SMITE_SIZE,
        now,
      });
      resetDue = active >= SMITES.max;
    }
    const after = await progressOf(trx, userId);
    const promoted = earnsKnighthood({
      level: getLevelProgression(exp).level,
      correct: after.correct,
      graded: after.graded,
    });
    if (promoted) {
      await promoteToKnight(trx, userId);
      await cleanseSmites(trx, { playerId: userId, reason: PROMOTION_CLEANSE, now });
    }
    return { status: 'recorded', correct, xp, gold, promoted, resetDue };
  });

  if (result.status !== 'recorded') return result;
  const { resetDue, ...recorded } = result;
  await mirrorXp(deps.mirrorXp, recorded.xp > 0 ? [{ playerId: userId, xp: recorded.xp }] : []);
  if (resetDue && deps.resetPlayer) await resetNow(userId, { resetPlayer: deps.resetPlayer });
  return recorded;
}

const LEVEL_UP_CLEANSE = 'Acolyte - Level up!';
const PROMOTION_CLEANSE = 'Acolyte - Knighted';

/** Wrong answers among the player's last `smiteWindow`, counting only answers given after their last such smite. */
async function wrongSinceLastSmite(trx: Executor, playerId: number): Promise<number> {
  const recent = answersOf(trx, playerId)
    .where(
      sql<SqlBool>`a."createdAt" > COALESCE((SELECT max(s."createdAt") FROM "NewOrderSmite" s WHERE s."targetPlayerId" = a."playerId" AND s."reason" = ${ACOLYTE_WRONG_ANSWER_SMITE}), 'epoch')`
    )
    .select('a.correct')
    .orderBy('a.id', 'desc')
    .limit(APPRENTICE.smiteWindow)
    .as('w');
  const row = await trx
    .selectFrom(recent)
    .select(sql<string>`count(*) filter (where not w.correct)`.as('wrong'))
    .executeTakeFirstOrThrow();
  return Number(row.wrong);
}

type TxResult =
  | Extract<AnswerResult, { status: 'rejected' }>
  | (Extract<AnswerResult, { status: 'recorded' }> & { resetDue: boolean });

/** Moves a player past the recap they are looking at. Safe to repeat; does nothing when no checkpoint is waiting. */
export type UnsureResult = { status: 'recorded' } | Extract<AnswerResult, { status: 'rejected' }>;

/**
 * "Not sure" on the practice pair on screen: one `KnightsUnsure` row, so confusing pairs stay countable, and the pair is
 * never dealt to the player again. No answer row, so no XP, no smite and nothing in the accuracy window.
 */
export async function unsureApprentice(
  db: Kysely<DB>,
  input: { userId: number; referenceId: number; version: string | null },
  deps: ApprenticeDeps
): Promise<UnsureResult> {
  const { userId, referenceId, version } = input;
  return db.transaction().execute(async (trx): Promise<UnsureResult> => {
    const player = await trx
      .selectFrom('NewOrderPlayer')
      .select('rankType')
      .where('userId', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!player) return { status: 'rejected', reason: 'no-player' };
    if (player.rankType !== 'Acolyte') return { status: 'rejected', reason: 'not-acolyte' };
    if ((await activeSmiteCount(trx, userId)) >= SMITES.max) {
      return { status: 'rejected', reason: 'reset-pending' };
    }
    if ((await standingOf(trx, userId)).checkpointPending) {
      return { status: 'rejected', reason: 'checkpoint-pending' };
    }
    const current = await findNext(trx, userId, deps.skillCheckRate ?? 0);
    if (!current || current.kind !== 'yesno' || current.referenceId !== referenceId) {
      return { status: 'rejected', reason: 'not-current' };
    }
    const pair = await trx
      .selectFrom('KnightsYesNoReference')
      .select(['active', sql<string>`"updatedAt"::text`.as('version')])
      .where('id', '=', referenceId)
      .executeTakeFirst();
    if (!pair || !pair.active || !version || pair.version !== version) {
      return { status: 'rejected', reason: 'not-current' };
    }
    await trx
      .insertInto('KnightsUnsure')
      .values({
        playerId: userId,
        yesNoReferenceId: referenceId,
        questionKey: current.questionKey,
        imageId: current.imageId,
        createdAt: utc(deps.now()),
      })
      .onConflict((oc) => oc.columns(['playerId', 'yesNoReferenceId']).doNothing())
      .execute();
    return { status: 'recorded' };
  });
}

export async function acknowledgeCheckpoint(
  db: Kysely<DB>,
  playerId: number,
  now: Date
): Promise<void> {
  if (!(await standingOf(db, playerId)).checkpointPending) return;
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
