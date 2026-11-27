import { sql, type Kysely } from 'kysely';
import {
  IMAGE_PULL_FILING,
  IMAGE_PULL_REPORTED,
  MOD_TAG_REVIEW_SOURCE,
  YESNO_REPORTED,
} from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_IMAGE_REPORT_REASON } from '@civitai/shared/new-order';
import type { ReportReason } from '$lib/report-reasons';
import { heldSql } from '../conversion/held';
import { backoffMinutes } from '../queue/queue.service';
import { SMITES } from '../smites/config';
import { activeSmiteCount } from '../smites/smites.service';
import { YESNO_AUDIENCE } from './keys';

/** The main app no longer has the image: no report is needed, and none is filed again. */
export const IMAGE_GONE = 'image-gone';

/** Files one main-app Report on the image and returns its id, or `IMAGE_GONE`; a throw leaves the pull to be filed again. */
export type FileImageReport = (imageId: number) => Promise<number | typeof IMAGE_GONE>;
export type ReportDeps = { threshold: number; fileReport: FileImageReport };

export type ReportOutcome = {
  /** A new report was stored: false for a repeat, or an item that is not an open player question. */
  recorded: boolean;
  /** This report took the question to the threshold: it is now `Reported`. */
  pulled: boolean;
  /** The image the pull also pulled (most of its reports named the image), else null. */
  pulledImage: number | null;
};

const NOTHING: ReportOutcome = { recorded: false, pulled: false, pulledImage: null };

/**
 * Stores a player's report of an open player yes/no question, once per player and question. At `threshold` distinct
 * reporters the question becomes `Reported`, so nobody is dealt it; when most of those reports name the image, the image is
 * pulled from every yes/no question and Acolyte pair too (`KnightsImagePull`, read by `yesNoServableImage`). A report from a
 * player whose vote would not count (held, so weighing 0, or due a career reset) is stored, so they are not dealt the
 * question again, but does not count. Runs under the item row lock, as a vote does, so exactly one report pulls it; it takes
 * no player lock, so the vote's order (player, then item) is never inverted. A tag review item takes no report.
 */
export async function recordReport(
  db: Kysely<DB>,
  input: { playerId: number; itemId: number; reason: ReportReason; now: Date },
  threshold: number
): Promise<ReportOutcome> {
  return db.transaction().execute(async (trx): Promise<ReportOutcome> => {
    const counted = !(await votesNotCounted(trx, input.playerId));
    const item = await trx
      .selectFrom('KnightsQueueItem')
      .select(['id', 'status', 'source', 'audience', 'questionKey', 'imageId'])
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !item ||
      item.status !== 'Open' ||
      item.audience !== YESNO_AUDIENCE.players ||
      item.source === MOD_TAG_REVIEW_SOURCE
    )
      return NOTHING;

    const stored = await trx
      .insertInto('KnightsQuestionReport')
      .values({
        playerId: input.playerId,
        itemId: item.id,
        reason: input.reason,
        questionKey: item.questionKey,
        imageId: item.imageId,
        createdAt: utc(input.now),
        counted,
      })
      .onConflict((oc) => oc.columns(['playerId', 'itemId']).doNothing())
      .executeTakeFirst();
    if (Number(stored.numInsertedOrUpdatedRows ?? 0) === 0) return NOTHING;
    if (!counted) return { recorded: true, pulled: false, pulledImage: null };

    // Reports a moderator already resolved (a question kept before) do not count again.
    const { reporters, image } = await trx
      .selectFrom('KnightsQuestionReport')
      .select([
        sql<number>`count(*)::int`.as('reporters'),
        sql<number>`count(*) FILTER (WHERE "reason" = ${KNIGHTS_IMAGE_REPORT_REASON})::int`.as(
          'image'
        ),
      ])
      .where('itemId', '=', item.id)
      .where('counted', '=', true)
      .where('resolvedAt', 'is', null)
      .executeTakeFirstOrThrow();
    if (reporters < threshold) return { recorded: true, pulled: false, pulledImage: null };

    await trx
      .updateTable('KnightsQueueItem')
      .set({ status: YESNO_REPORTED, updatedAt: utc(input.now) })
      .where('id', '=', item.id)
      .execute();
    const imagePulled = image * 2 > reporters;
    if (imagePulled) {
      await trx
        .insertInto('KnightsImagePull')
        .values({
          imageId: item.imageId,
          itemId: item.id,
          reason: IMAGE_PULL_REPORTED,
          createdAt: utc(input.now),
        })
        .onConflict((oc) => oc.column('imageId').where('resolvedAt', 'is', null).doNothing())
        .execute();
    }
    return { recorded: true, pulled: true, pulledImage: imagePulled ? item.imageId : null };
  });
}

/** Whether the player's votes would not count: held (weight 0) or due a career reset (refused). */
async function votesNotCounted(db: Kysely<DB>, playerId: number): Promise<boolean> {
  const { rows } = await sql<{ held: boolean }>`SELECT ${heldSql(
    'me.id'
  )} AS held FROM (SELECT ${playerId}::int AS id) me`.execute(db);
  if (rows[0]?.held) return true;
  return (await activeSmiteCount(db, playerId)) >= SMITES.max;
}

type FileOutcome = 'filed' | 'failed' | 'not-needed' | 'none';

/**
 * Files the main-app Report for the image's open pull, once per image: a pull already filed (or not needed), or an image an
 * earlier pull filed for, calls nothing. Each call to the main app counts an attempt. A failed filing is logged and leaves
 * the pull open and pending (the image stays out of Knights) for the tick (`fileOpenImagePulls`) or the next pull.
 */
export async function fileImagePull(
  db: Kysely<DB>,
  imageId: number,
  fileReport: FileImageReport,
  now: Date = new Date()
): Promise<FileOutcome> {
  const pulls = await db
    .selectFrom('KnightsImagePull')
    .select(['id', 'reportId', 'filing', 'resolvedAt'])
    .where('imageId', '=', imageId)
    .orderBy('id', 'desc')
    .execute();
  const open = pulls.find((pull) => pull.resolvedAt === null);
  if (!open || open.filing !== IMAGE_PULL_FILING.pending) return 'none';
  const pending = (eb: Kysely<DB>) =>
    eb
      .updateTable('KnightsImagePull')
      .where('id', '=', open.id)
      .where('filing', '=', IMAGE_PULL_FILING.pending);

  const earlier = pulls.find((pull) => pull.reportId !== null)?.reportId ?? null;
  if (earlier !== null) {
    await pending(db).set({ reportId: earlier, filing: IMAGE_PULL_FILING.filed }).execute();
    return 'filed';
  }
  const attempted = {
    attempts: sql<number>`"attempts" + 1`,
    lastAttemptAt: utc(now),
  };
  let answer: Awaited<ReturnType<FileImageReport>>;
  try {
    answer = await fileReport(imageId);
  } catch (error) {
    console.error('knights: could not file the main-app report for a pulled image', {
      imageId,
      error,
    });
    await pending(db).set(attempted).execute();
    return 'failed';
  }
  if (answer === IMAGE_GONE) {
    await pending(db)
      .set({ ...attempted, filing: IMAGE_PULL_FILING.notNeeded })
      .execute();
    return 'not-needed';
  }
  await pending(db)
    .set({ ...attempted, reportId: answer, filing: IMAGE_PULL_FILING.filed })
    .execute();
  return 'filed';
}

/** The skip action's report: stored, and an image pull filed, without ever failing the skip. Logged when it cannot be stored. */
export async function reportYesNo(
  db: Kysely<DB>,
  input: { playerId: number; itemId: number; reason: ReportReason; now: Date },
  deps: () => Promise<ReportDeps>
): Promise<ReportOutcome> {
  try {
    const { threshold, fileReport } = await deps();
    const outcome = await recordReport(db, input, threshold);
    if (outcome.pulledImage !== null) await fileImagePull(db, outcome.pulledImage, fileReport, input.now);
    return outcome;
  } catch (error) {
    console.error('knights: could not record a yes/no report', {
      playerId: input.playerId,
      itemId: input.itemId,
      error,
    });
    return NOTHING;
  }
}

/**
 * The tick's retry of open pulls still pending a filing. Fewest attempts first, then the longest waiting, so a backlog of
 * failing pulls cannot starve a new one; a failed one waits out `backoffMinutes(attempts)`. Up to `concurrency` filings run
 * at once, and none starts once `budgetMs` is spent, like the rating write-back (`applyPendingResolutions`).
 */
export async function fileOpenImagePulls(
  db: Kysely<DB>,
  fileReport: FileImageReport,
  {
    now = new Date(),
    limit = 100,
    concurrency = 4,
    budgetMs = 45_000,
  }: { now?: Date; limit?: number; concurrency?: number; budgetMs?: number } = {}
): Promise<{ filed: number; failed: number; notNeeded: number }> {
  const waiting = await db
    .selectFrom('KnightsImagePull')
    .select(['imageId', 'attempts', 'lastAttemptAt'])
    .where('resolvedAt', 'is', null)
    .where('filing', '=', IMAGE_PULL_FILING.pending)
    .orderBy('attempts', 'asc')
    .orderBy(sql`"lastAttemptAt" ASC NULLS FIRST`)
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  const due = waiting.filter(
    (pull) =>
      pull.lastAttemptAt === null ||
      pull.lastAttemptAt.getTime() + backoffMinutes(pull.attempts) * 60_000 <= now.getTime()
  );

  const result = { filed: 0, failed: 0, notNeeded: 0 };
  const startedAt = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < due.length && Date.now() - startedAt < budgetMs) {
      const outcome = await fileImagePull(db, due[next++].imageId, fileReport, now);
      if (outcome === 'filed') result.filed++;
      else if (outcome === 'failed') result.failed++;
      else if (outcome === 'not-needed') result.notNeeded++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return result;
}
