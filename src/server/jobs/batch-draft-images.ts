import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { deleteImages } from '~/server/services/image.service';
import {
  batchDraftDeletableSql,
  BATCH_DRAFT_RETENTION_DAYS,
} from '~/server/services/post-batch.service';
import { decreaseDate } from '~/utils/date-helpers';

const BATCH_SIZE = 500;
/** Deletes per run; the rest drains on later runs, oldest first. */
const MAX_PER_RUN = 5000;

/** Oldest-first ids of deletable batch drafts past retention. */
export async function selectExpiredBatchDraftImageIds(cutoff: Date, limit: number) {
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT "Image".id FROM "Image"
    WHERE ${batchDraftDeletableSql()}
      AND "Image"."createdAt" < ${cutoff}
    ORDER BY "Image"."createdAt"
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

/**
 * Reaps composer uploads that were persisted as postless `Image` rows (`persistBatchMedia`) and
 * never scheduled. A draft lives in one browser; one abandoned there has no other way out.
 */
export const batchDraftImagesCleanup = createJob(
  'batch-draft-images-cleanup',
  '35 5 * * *',
  async ({ checkIfCanceled }) => {
    const cutoff = decreaseDate(new Date(), BATCH_DRAFT_RETENTION_DAYS, 'days');
    let ids = await selectExpiredBatchDraftImageIds(cutoff, BATCH_SIZE);

    // Same two guards `remove-replaced-images` carries: a local run, or an app pointed at a
    // non-prod copy, must never mass-delete production media out of a restored snapshot.
    if (!isProd) return { wouldDelete: ids.length };
    if (!env.DATABASE_IS_PROD) return { wouldDelete: 0 };

    let deleted = 0;
    while (ids.length) {
      checkIfCanceled();
      // Re-checked on the primary: a draft the replica still shows as postless may have been
      // scheduled, or held, since.
      const removed = await deleteImages(ids, false, { onlyWhere: batchDraftDeletableSql() });
      deleted += removed.length;
      if (ids.length < BATCH_SIZE || deleted >= MAX_PER_RUN) break;
      ids = await selectExpiredBatchDraftImageIds(
        cutoff,
        Math.min(BATCH_SIZE, MAX_PER_RUN - deleted)
      );
    }
    logToAxiom({
      name: 'batch-draft-images-cleanup',
      type: 'info',
      message: 'finished',
      deleted,
    }).catch(() => undefined);
    return { deleted };
  },
  // Up to 5000 S3 deletes; a second pod taking the default 5-minute lock mid-run would double up.
  { lockExpiration: 20 * 60 }
);
