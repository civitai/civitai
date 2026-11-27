import { sql, type Kysely } from 'kysely';
import { IMAGE_PULL_REPORTED, MOD_TAG_REVIEW_SOURCE, YESNO_REPORTED } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import type { ReportReason } from '$lib/report-reasons';
import { YESNO_AUDIENCE } from './keys';

/** Files one main-app Report on the image and returns its id; a throw leaves the pull without one, to be filed again. */
export type FileImageReport = (imageId: number) => Promise<number>;

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
 * pulled from every yes/no question and Acolyte pair too (`KnightsImagePull`, read by `yesNoServableImage`). Runs under the
 * item row lock, as a vote does, so exactly one report pulls it; it takes no player lock, so the vote's order (player, then
 * item) is never inverted. A tag review item takes no report.
 */
export async function recordReport(
  db: Kysely<DB>,
  input: { playerId: number; itemId: number; reason: ReportReason; now: Date },
  threshold: number
): Promise<ReportOutcome> {
  return db.transaction().execute(async (trx): Promise<ReportOutcome> => {
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
      })
      .onConflict((oc) => oc.columns(['playerId', 'itemId']).doNothing())
      .executeTakeFirst();
    if (Number(stored.numInsertedOrUpdatedRows ?? 0) === 0) return NOTHING;

    // Reports a moderator already resolved (a question kept before) do not count again.
    const { reporters, image } = await trx
      .selectFrom('KnightsQuestionReport')
      .select([
        sql<number>`count(*)::int`.as('reporters'),
        sql<number>`count(*) FILTER (WHERE "reason" = 'image')::int`.as('image'),
      ])
      .where('itemId', '=', item.id)
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
        .values({ imageId: item.imageId, reason: IMAGE_PULL_REPORTED, createdAt: utc(input.now) })
        .onConflict((oc) => oc.column('imageId').where('resolvedAt', 'is', null).doNothing())
        .execute();
    }
    return { recorded: true, pulled: true, pulledImage: imagePulled ? item.imageId : null };
  });
}

/**
 * Files the main-app Report for the image's open pull, once per image: a pull that has a report id, or an image an earlier
 * pull already filed for, calls nothing. A failed filing is logged and leaves the pull open without a report id (the image
 * stays out of Knights); the next pull of the image or the tick (`fileOpenImagePulls`) files it again. Returns the report id.
 */
export async function fileImagePull(
  db: Kysely<DB>,
  imageId: number,
  fileReport: FileImageReport
): Promise<number | null> {
  const pulls = await db
    .selectFrom('KnightsImagePull')
    .select(['id', 'reportId', 'resolvedAt'])
    .where('imageId', '=', imageId)
    .orderBy('id', 'desc')
    .execute();
  const open = pulls.find((pull) => pull.resolvedAt === null);
  if (!open) return null;
  if (open.reportId !== null) return open.reportId;

  let reportId = pulls.find((pull) => pull.reportId !== null)?.reportId ?? null;
  if (reportId === null) {
    try {
      reportId = await fileReport(imageId);
    } catch (error) {
      console.error('knights: could not file the main-app report for a pulled image', {
        imageId,
        error,
      });
      return null;
    }
  }
  await db
    .updateTable('KnightsImagePull')
    .set({ reportId })
    .where('id', '=', open.id)
    .where('reportId', 'is', null)
    .execute();
  return reportId;
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
    if (outcome.pulledImage !== null) await fileImagePull(db, outcome.pulledImage, fileReport);
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

/** The tick's retry: files every open pull still without a report id, oldest first, up to `limit`. */
export async function fileOpenImagePulls(
  db: Kysely<DB>,
  fileReport: FileImageReport,
  { limit = 50 }: { limit?: number } = {}
): Promise<{ filed: number; failed: number }> {
  const waiting = await db
    .selectFrom('KnightsImagePull')
    .select('imageId')
    .where('resolvedAt', 'is', null)
    .where('reportId', 'is', null)
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  const result = { filed: 0, failed: 0 };
  for (const { imageId } of waiting) {
    if ((await fileImagePull(db, imageId, fileReport)) === null) result.failed++;
    else result.filed++;
  }
  return result;
}
