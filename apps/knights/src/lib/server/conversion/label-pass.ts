import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  ensureChoiceRules,
  ensureYesNoRules,
  hasUnlabelled,
  writeLabelBatch,
  type LabelCursor,
} from './labels';

export type PassLog = (event: Record<string, unknown>) => unknown;

export type LabelPassResult = {
  /** False when the time budget ran out; the next tick resumes from the data. */
  done: boolean;
  labelsWritten: number;
  labelFailures: number;
};

const DEFAULTS = { budgetMs: 30_000, batchSize: 200 };

/** Writes the labels of every graded vote and every given yes/no answer not yet labelled. Writes are keyed on the data (unlabelled votes), so a cut-short or repeated pass loses and duplicates nothing. */
export async function runLabelPass(
  db: Kysely<DB>,
  {
    now,
    log,
    budgetMs = DEFAULTS.budgetMs,
    batchSize = DEFAULTS.batchSize,
  }: { now: Date; log?: PassLog; budgetMs?: number; batchSize?: number }
): Promise<LabelPassResult> {
  const deadline = Date.now() + budgetMs;
  const outOfTime = () => Date.now() >= deadline;
  const totals = { labelsWritten: 0, labelFailures: 0 };

  // Yes/no answers are labelled as given, not when graded; the cursor is their own.
  let done = true;
  for (const kind of ['rating', 'yesno'] as const) {
    if (outOfTime()) {
      done = false;
      continue;
    }
    if (!(await hasUnlabelled(db, kind))) continue;
    await (kind === 'yesno' ? ensureYesNoRules(db) : ensureChoiceRules(db));
    let cursor: LabelCursor | null = null;
    let kindDone = false;
    while (!kindDone && !outOfTime()) {
      const batch = await writeLabelBatch(db, { after: cursor, limit: batchSize, kind });
      totals.labelsWritten += batch.written;
      totals.labelFailures += batch.failed;
      cursor = batch.cursor;
      kindDone = batch.scanned < batchSize;
    }
    done &&= kindDone;
  }

  if (totals.labelsWritten > 0 || totals.labelFailures > 0)
    await logPassSummary(db, log, { now, done, ...totals });
  return { done, ...totals };
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
  summary: { now: Date } & Record<string, number | boolean | Date>
) {
  if (!log) return;
  try {
    const { now, ...rest } = summary;
    await log({
      type: 'info',
      name: 'knights-label-pass',
      details: { ...rest, buzzConvertedPerDay: await convertedPerDay(db, now as Date) },
    });
  } catch (error) {
    console.error('knights: could not log the label pass', error);
  }
}
