import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_SOURCE } from '@civitai/db/knights';
import type { QuestionOption } from '../queue/queue.service';
import { servableReferences } from '../reference';
import { TRIAL_MODULES, TRIALS } from './config';
import { planRun, scoreRun } from './plan';
import { utc } from '@civitai/db/kysely';

type Executor = Kysely<DB> | Transaction<DB>;

export type TrialDeps = { now: () => Date; newSeed: () => number };

export type TrialItem = {
  referenceId: number;
  imageKey: string;
  width: number | null;
  height: number | null;
};

export type TrialView =
  | { kind: 'not-acolyte' }
  | { kind: 'unavailable' }
  | { kind: 'cooldown'; until: Date }
  | {
      kind: 'question';
      questionKey: string;
      prompt: string;
      options: QuestionOption[];
      run: { id: number; position: number; total: number };
      item: TrialItem;
    };

export type AnswerResult =
  | { status: 'rejected'; reason: 'no-player' | 'no-run' | 'not-current' | 'bad-answer' }
  | {
      status: 'recorded';
      correct: boolean;
      correctAnswer: string;
      correctLabel: string;
      explanation: string | null;
      imageKey: string;
      finished: { result: 'passed' | 'failed' | 'void'; score: number | null } | null;
    };

type Run = {
  id: number;
  questionKey: string;
  itemIds: number[];
  /** The fresh items as planned. Null on a run stored before roles were kept, which falls back to each item's current source. */
  freshIds: ReadonlySet<number> | null;
};

type StoredPlan = number[] | { core: number[]; fresh: number[] };

const toRun = (row: { id: number; questionKey: string; itemIds: unknown }): Run => {
  const plan = row.itemIds as StoredPlan;
  return Array.isArray(plan)
    ? { id: row.id, questionKey: row.questionKey, itemIds: plan, freshIds: null }
    : {
        id: row.id,
        questionKey: row.questionKey,
        itemIds: [...plan.core, ...plan.fresh],
        freshIds: new Set(plan.fresh),
      };
};

function servableTrialReferences(db: Executor, questionKey: string) {
  return servableReferences(db, REFERENCE_POOL.trials).where('r.questionKey', '=', questionKey);
}

export async function promoteToKnight(db: Executor, userId: number) {
  await db
    .insertInto('NewOrderPlayer')
    .values({ userId, rankType: 'Knight' })
    .onConflict((oc) =>
      oc
        .column('userId')
        .doUpdateSet({ rankType: 'Knight' })
        .where('NewOrderPlayer.rankType', '=', 'Acolyte')
    )
    .execute();
}

/** A pass before the player's last reset (`startAt`) does not count. */
async function passedModules(db: Executor, userId: number): Promise<Set<string>> {
  const rows = await db
    .selectFrom('KnightsTrialRun as run')
    .leftJoin('NewOrderPlayer as player', 'player.userId', 'run.playerId')
    .select('run.questionKey')
    .distinct()
    .where('run.playerId', '=', userId)
    .where('run.result', '=', 'passed')
    .where((eb) =>
      eb.or([
        eb('player.startAt', 'is', null),
        eb('run.finishedAt', '>=', eb.ref('player.startAt')),
      ])
    )
    .execute();
  return new Set(rows.map((r) => r.questionKey));
}

async function loadQuestion(db: Executor, questionKey: string) {
  const question = await db
    .selectFrom('KnightsQuestion')
    .select(['prompt', 'options'])
    .where('key', '=', questionKey)
    .executeTakeFirstOrThrow();
  return { prompt: question.prompt, options: question.options as QuestionOption[] };
}

async function openRun(db: Executor, userId: number, questionKey: string): Promise<Run | null> {
  const row = await db
    .selectFrom('KnightsTrialRun')
    .select(['id', 'questionKey', 'itemIds'])
    .where('playerId', '=', userId)
    .where('questionKey', '=', questionKey)
    .where('finishedAt', 'is', null)
    .executeTakeFirst();
  return row ? toRun(row) : null;
}

async function startRun(
  db: Executor,
  userId: number,
  questionKey: string,
  deps: TrialDeps
): Promise<Run | null> {
  const [pool, met] = await Promise.all([
    servableTrialReferences(db, questionKey).select(['r.id', 'r.source']).execute(),
    db
      .selectFrom('KnightsTrialAnswer')
      .select('referenceId')
      .distinct()
      .where('playerId', '=', userId)
      .execute(),
  ]);
  const seen = new Set(met.map((m) => m.referenceId));
  const freshUnseen = pool.filter((r) => r.source !== REFERENCE_SOURCE.core && !seen.has(r.id));
  if (freshUnseen.length < TRIALS.minFresh) return null;

  const seed = deps.newSeed();
  const plan = planRun({
    seed,
    core: pool.filter((r) => r.source === REFERENCE_SOURCE.core).map((r) => r.id),
    freshUnseen: freshUnseen.map((r) => r.id),
    length: TRIALS.runLength,
    freshCount: TRIALS.freshCount,
  });

  // Overlapping loads race to open the run; the partial unique index lets one win, and the rest read its run.
  await db
    .insertInto('KnightsTrialRun')
    .values({
      playerId: userId,
      questionKey,
      seed,
      itemIds: JSON.stringify({ core: plan.core, fresh: plan.fresh }),
      startedAt: utc(deps.now()),
    })
    .onConflict((oc) =>
      oc.columns(['playerId', 'questionKey']).where('finishedAt', 'is', null).doNothing()
    )
    .execute();
  return openRun(db, userId, questionKey);
}

async function nextItem(
  db: Executor,
  run: Run
): Promise<{ item: TrialItem; position: number } | null> {
  const answered = new Set(
    (
      await db
        .selectFrom('KnightsTrialAnswer')
        .select('referenceId')
        .where('runId', '=', run.id)
        .execute()
    ).map((a) => a.referenceId)
  );
  const remaining = run.itemIds.filter((id) => !answered.has(id));
  if (remaining.length === 0) return null;

  const servable = await servableTrialReferences(db, run.questionKey)
    .select(['r.id', 'img.url as imageKey', 'img.width', 'img.height'])
    .where('r.id', 'in', remaining)
    .execute();
  const byId = new Map(servable.map((s) => [s.id, s]));
  const id = remaining.find((candidate) => byId.has(candidate));
  if (id === undefined) return null;
  const row = byId.get(id)!;
  return {
    position: answered.size + 1,
    item: { referenceId: id, imageKey: row.imageKey, width: row.width, height: row.height },
  };
}

async function finishRun(db: Executor, run: Run, userId: number, now: Date) {
  const answers = await db
    .selectFrom('KnightsTrialAnswer as a')
    .innerJoin('KnightsReferenceImage as r', 'r.id', 'a.referenceId')
    .select(['a.correct', 'a.referenceId', 'r.source'])
    .where('a.runId', '=', run.id)
    .execute();
  const { result, score } = scoreRun(
    answers.map((a) => ({
      fresh: run.freshIds ? run.freshIds.has(a.referenceId) : a.source !== REFERENCE_SOURCE.core,
      correct: a.correct,
    })),
    TRIALS
  );
  const cooldownUntil = new Date(now.getTime() + TRIALS.cooldownHours * 3_600_000);
  const closed = await db
    .updateTable('KnightsTrialRun')
    .set({
      finishedAt: utc(now),
      result,
      score,
      cooldownUntil: result === 'failed' ? utc(cooldownUntil) : null,
    })
    .where('id', '=', run.id)
    .where('finishedAt', 'is', null)
    .executeTakeFirst();
  if (Number(closed.numUpdatedRows) === 0) return null;

  if (result === 'passed') {
    const done = await passedModules(db, userId);
    if (TRIAL_MODULES.every((key) => done.has(key))) await promoteToKnight(db, userId);
  }
  return { result, score };
}

export function getTrial(db: Kysely<DB>, userId: number, deps: TrialDeps): Promise<TrialView> {
  return resolveTrial(db, userId, deps, false);
}

/** `justClosed`: re-entry after closing a run; do not recurse into another close. */
async function resolveTrial(
  db: Kysely<DB>,
  userId: number,
  deps: TrialDeps,
  justClosed: boolean
): Promise<TrialView> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select('rankType')
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (player && player.rankType !== 'Acolyte') return { kind: 'not-acolyte' };

  const done = await passedModules(db, userId);
  const questionKey = TRIAL_MODULES.find((key) => !done.has(key));
  if (!questionKey) {
    await promoteToKnight(db, userId);
    return { kind: 'not-acolyte' };
  }

  const now = deps.now();
  let run = await openRun(db, userId, questionKey);
  if (!run) {
    const last = await db
      .selectFrom('KnightsTrialRun')
      .select('cooldownUntil')
      .where('playerId', '=', userId)
      .where('questionKey', '=', questionKey)
      .where('finishedAt', 'is not', null)
      .orderBy('finishedAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (last?.cooldownUntil && last.cooldownUntil > now) {
      return { kind: 'cooldown', until: last.cooldownUntil };
    }
    run = await startRun(db, userId, questionKey, deps);
    if (!run) return { kind: 'unavailable' };
  }

  const next = await nextItem(db, run);
  if (!next) {
    await finishRun(db, run, userId, now);
    return justClosed ? { kind: 'unavailable' } : resolveTrial(db, userId, deps, true);
  }
  return {
    kind: 'question',
    questionKey,
    ...(await loadQuestion(db, questionKey)),
    run: { id: run.id, position: next.position, total: run.itemIds.length },
    item: next.item,
  };
}

export async function answerTrial(
  db: Kysely<DB>,
  input: { userId: number; questionKey: string; referenceId: number; answer: string },
  deps: TrialDeps
): Promise<AnswerResult> {
  const { userId, questionKey, referenceId, answer } = input;
  const now = deps.now();

  return db.transaction().execute(async (trx): Promise<AnswerResult> => {
    const member = await trx
      .selectFrom('NewOrderPlayer')
      .select('userId')
      .where('userId', '=', userId)
      .executeTakeFirst();
    if (!member) return { status: 'rejected', reason: 'no-player' };

    const locked = await trx
      .selectFrom('KnightsTrialRun')
      .select(['id', 'questionKey', 'itemIds'])
      .where('playerId', '=', userId)
      .where('questionKey', '=', questionKey)
      .where('finishedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) return { status: 'rejected', reason: 'no-run' };
    const run = toRun(locked);

    const next = await nextItem(trx, run);
    if (next?.item.referenceId !== referenceId)
      return { status: 'rejected', reason: 'not-current' };

    const { options } = await loadQuestion(trx, run.questionKey);
    if (!options.some((option) => option.value === answer)) {
      return { status: 'rejected', reason: 'bad-answer' };
    }

    const reference = await trx
      .selectFrom('KnightsReferenceImage')
      .select(['answer', 'source', 'explanation'])
      .where('id', '=', referenceId)
      .executeTakeFirstOrThrow();
    const correct = reference.answer === answer;

    await trx
      .insertInto('KnightsTrialAnswer')
      .values({
        runId: run.id,
        playerId: userId,
        referenceId,
        answer,
        correct,
        createdAt: utc(now),
      })
      .execute();
    await trx
      .updateTable('KnightsReferenceImage')
      .set({
        answers: sql`"answers" + 1`,
        failures: correct ? sql`"failures"` : sql`"failures" + 1`,
      })
      .where('id', '=', referenceId)
      .execute();

    const finished = (await nextItem(trx, run)) ? null : await finishRun(trx, run, userId, now);
    return {
      status: 'recorded',
      correct,
      correctAnswer: reference.answer,
      correctLabel: options.find((o) => o.value === reference.answer)?.label ?? reference.answer,
      explanation: reference.source === REFERENCE_SOURCE.core ? reference.explanation : null,
      imageKey: next.item.imageKey,
      finished,
    };
  });
}
