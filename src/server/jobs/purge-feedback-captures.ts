import { Prisma } from '@prisma/client';
import {
  FEEDBACK_CAPTURE_OWNER_ID,
  FEEDBACK_CAPTURE_RETENTION_DAYS,
} from '@civitai/shared/feedback-capture';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { deleteImages } from '~/server/services/image.service';
import { decreaseDate } from '~/utils/date-helpers';

/** Bounds how much of a backlog one run pulls in. Oldest-first, so the remainder drains later. */
const BATCH_SIZE = 2000;

const captureOwner = Prisma.raw(String(FEEDBACK_CAPTURE_OWNER_ID));

/** What the DELETE itself re-checks. Only valid on a statement over an unaliased "Image". */
export function feedbackCaptureDeleteGuard(cutoff: Date) {
  return Prisma.sql`
    "Image"."userId" = ${captureOwner}
    AND "Image"."createdAt" < ${cutoff}
  `;
}

/** The oldest captures past `cutoff`. */
export function expiredCapturesSql(cutoff: Date, limit = BATCH_SIZE) {
  return Prisma.sql`
    SELECT i.id FROM "Image" i
    WHERE i."userId" = ${captureOwner}
      AND i."createdAt" < ${cutoff}
    ORDER BY i."createdAt" ASC, i.id ASC
    LIMIT ${limit}
  `;
}

/** Deletes feedback page captures past their retention window. */
export const purgeFeedbackCaptures = createJob(
  'purge-feedback-captures',
  '40 5 * * *',
  async () => {
    const cutoff = decreaseDate(new Date(), FEEDBACK_CAPTURE_RETENTION_DAYS, 'days');
    const expired = await dbWrite.$queryRaw<{ id: number }[]>(expiredCapturesSql(cutoff));
    const ids = expired.map((r) => r.id);

    // A local run, or an app pointed at a non-prod copy, must never delete production media.
    if (!isProd || !env.DATABASE_IS_PROD) return { wouldDelete: ids.length };

    const deleted = ids.length
      ? (
          await deleteImages(ids, {
            actor: { system: 'purge-feedback-captures' },
            onlyWhere: feedbackCaptureDeleteGuard(cutoff),
          })
        ).map((r) => r.id)
      : [];
    const deletedSet = new Set(deleted);
    const skipped = ids.filter((id) => !deletedSet.has(id));
    const result = { deleted: deleted.length, skippedByGuard: skipped.length };
    logToAxiom({
      type: 'info',
      name: 'purge-feedback-captures',
      message: 'Purged expired feedback page captures',
      ...result,
      deletedIds: deleted,
      skippedIds: skipped,
    });
    return result;
  }
);
