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
  AND (
    i.ingestion IN ('Scanned', 'Error', 'NotFound')
    OR (i.ingestion IN ('Pending', 'Rescan') AND i."createdAt" < now() - interval '1 day')
  )
  AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL
  AND i.minor = false
  AND i."tosViolation" = false
  AND NOT EXISTS (SELECT 1 FROM "ScanLabelItem" s WHERE s."imageId" = i.id)
  AND NOT EXISTS (SELECT 1 FROM "EvidenceHoldImage" e WHERE e."imageId" = i.id)
  AND NOT EXISTS (
    SELECT 1 FROM "CsamReport" r WHERE r."userId" = i."userId" AND r."reportSentAt" IS NULL
  )
`;
const BATCH = 500;

/**
 * Deletes a search-by-upload row an hour after upload once its scan finished (a day if the scan
 * never answered). Held or flagged rows are kept: deleting an image cascades its pending
 * ScanLabelItem vote, a ToS violation may be moderation evidence, and an uploader with an unsent
 * CSAM report keeps every row.
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
    SELECT (x.indisvalid AND x.indisready) AS valid
    FROM pg_index x
    JOIN pg_class c ON c.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${SWEEP_INDEX} AND c.relkind = 'i' AND n.nspname = 'public'
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
