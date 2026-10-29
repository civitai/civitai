import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { clearGoldBatch } from './clearing';
import { ensureQuestionRules, writeLabelBatch, type LabelCursor } from './labels';

export type PassLog = (event: Record<string, unknown>) => unknown;

export type PassResult =
  | { ran: false }
  | {
      ran: true;
      runId: number;
      /** False when the time budget ran out; the next tick resumes from the data. */
      done: boolean;
      clearedPlayers: number;
      clearedGold: number;
      labelsWritten: number;
      labelFailures: number;
    };

const DEFAULTS = { budgetMs: 30_000, batchSize: 200 };

/** Clears gold and writes labels for the newest detection run no pass has handled, so the tick can call it every time. Writes are keyed on the data (uncleared gold, unlabelled votes), so a cut-short or repeated pass loses and duplicates nothing. */
export async function runPostDetectionPass(
  db: Kysely<DB>,
  {
    now,
    log,
    budgetMs = DEFAULTS.budgetMs,
    batchSize = DEFAULTS.batchSize,
  }: { now: Date; log?: PassLog; budgetMs?: number; batchSize?: number }
): Promise<PassResult> {
  const run = await db
    .selectFrom('KnightsDetectionRun')
    .select(['id', 'completedAt'])
    .where('passedAt', 'is', null)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!run) return { ran: false };

  await ensureQuestionRules(db);

  const deadline = Date.now() + budgetMs;
  const outOfTime = () => Date.now() >= deadline;
  const totals = { clearedPlayers: 0, clearedGold: 0, labelsWritten: 0, labelFailures: 0 };

  let afterPlayerId = 0;
  let goldDone = false;
  while (!goldDone && !outOfTime()) {
    const batch = await clearGoldBatch(db, run, { afterPlayerId, limit: batchSize });
    totals.clearedPlayers += batch.players;
    totals.clearedGold += batch.gold;
    afterPlayerId = batch.lastPlayerId;
    goldDone = batch.scanned < batchSize;
  }

  let cursor: LabelCursor | null = null;
  let labelsDone = false;
  while (goldDone && !labelsDone && !outOfTime()) {
    const batch = await writeLabelBatch(db, {
      settledBefore: run.completedAt,
      after: cursor,
      limit: batchSize,
    });
    totals.labelsWritten += batch.written;
    totals.labelFailures += batch.failed;
    cursor = batch.cursor;
    labelsDone = batch.scanned < batchSize;
  }

  const done = goldDone && labelsDone;
  if (done) {
    await db
      .updateTable('KnightsDetectionRun')
      .set({ passedAt: utc(now) })
      .where('passedAt', 'is', null)
      .where('id', '<=', run.id)
      .execute();
    await logPassSummary(db, log, { runId: run.id, now, ...totals });
  }
  return { ran: true, runId: run.id, done, ...totals };
}

export async function convertedPerDay(
  db: Kysely<DB>,
  now: Date
): Promise<{ day: string; buzz: number; conversions: number }[]> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const { rows } = await sql<{ day: string; buzz: number; conversions: number }>`
    SELECT to_char("paidAt"::date, 'YYYY-MM-DD') AS "day",
      sum("buzz")::int AS "buzz", count(*)::int AS "conversions"
    FROM "KnightsGoldConversion"
    WHERE "status" = 'paid' AND "paidAt" >= ${utc(from)}
    GROUP BY 1
    ORDER BY 1
  `.execute(db);
  return rows.map((r) => ({
    day: r.day,
    buzz: Number(r.buzz),
    conversions: Number(r.conversions),
  }));
}

async function logPassSummary(
  db: Kysely<DB>,
  log: PassLog | undefined,
  summary: { runId: number; now: Date } & Record<string, number | Date>
) {
  if (!log) return;
  try {
    const { now, ...rest } = summary;
    await log({
      type: 'info',
      name: 'knights-post-detection-pass',
      details: { ...rest, buzzConvertedPerDay: await convertedPerDay(db, now as Date) },
    });
  } catch (error) {
    console.error('knights: could not log the post-detection pass', error);
  }
}
