import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { SEARCH_UPLOAD_APP_ID_META_KEY } from '~/shared/utils/block-provenance-metadata';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';

const log = createLogger('search-upload-sweep', 'blue');

const SWEEP_INDEX = 'Image_searchUpload_idx';
// The key is inlined so the planner matches the partial index's predicate.
const SWEEPABLE = Prisma.sql`
  i."postId" IS NULL AND (i.metadata ? ${Prisma.raw(`'${SEARCH_UPLOAD_APP_ID_META_KEY}'`)})
  AND i."createdAt" < now() - interval '1 hour'
  AND i.ingestion = 'Scanned'
  AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL
  AND i.minor = false
  AND NOT EXISTS (SELECT 1 FROM "ScanLabelItem" s WHERE s."imageId" = i.id)
  AND NOT EXISTS (SELECT 1 FROM "EvidenceHoldImage" e WHERE e."imageId" = i.id)
`;
const BATCH = 500;

/**
 * Deletes search-by-upload rows an hour after they were written, but only those that passed the
 * scan cleanly. A row held or flagged in any way is kept: a minor or CSAM-like flag follows the
 * CSAM path, and deleting the image would cascade its ScanLabelItem (a pending vote) away.
 * Runs whether the feature flag is on or off.
 */
export const searchUploadSweepJob = createJob('search-upload-sweep', '*/10 * * * *', () =>
  sweepSearchUploads()
);

export async function sweepSearchUploads({
  deleteImage = async (id: number) => {
    const { deleteImageById } = await import('~/server/services/image.service');
    await deleteImageById({ id, updatePost: false });
  },
}: { deleteImage?: (id: number) => Promise<void> } = {}) {
  // Without the partial index this would scan the whole Image table every run.
  const [index] = await dbWrite.$queryRaw<{ valid: boolean }[]>`
    SELECT x.indisvalid AS valid
    FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
    WHERE c.relname = ${SWEEP_INDEX}
  `;
  if (!index?.valid) {
    log(`${SWEEP_INDEX} is missing or invalid: nothing swept`);
    return { swept: 0, skipped: true };
  }

  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i WHERE ${SWEEPABLE} ORDER BY i."createdAt" LIMIT ${BATCH}
  `;
  if (!rows.length) return { swept: 0 };

  let swept = 0;
  for (const { id } of rows) {
    try {
      // Re-checked one by one: a hold or flag can land while the batch runs.
      const [still] = await dbWrite.$queryRaw<{ id: number }[]>`
        SELECT i.id FROM "Image" i WHERE i.id = ${id} AND ${SWEEPABLE}
      `;
      if (!still) continue;
      await deleteImage(id);
      swept++;
    } catch (error) {
      log(`failed to sweep image ${id}: ${(error as Error).message}`);
    }
  }
  return { swept };
}
