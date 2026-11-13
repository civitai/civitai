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
import {
  captureHoldLegsSql,
  captureImageHeldSql,
  ownerHeldSql,
  type CaptureHoldLeg,
} from '~/server/services/legal-hold.service';
import { decreaseDate } from '~/utils/date-helpers';

/** Bounds how much of a backlog one run pulls in. Oldest-first, so the remainder drains later. */
const BATCH_SIZE = 2000;
/** Most kept ids one run logs; the counts cover them all. */
const KEPT_IDS_LOGGED = 500;

const captureOwner = Prisma.raw(String(FEEDBACK_CAPTURE_OWNER_ID));

/**
 * What the DELETE itself re-checks, so a hold placed after the batch was read still keeps the
 * capture. Only valid on a statement over an unaliased "Image".
 */
export function feedbackCaptureDeleteGuard(cutoff: Date) {
  return Prisma.sql`
    "Image"."userId" = ${captureOwner}
    AND "Image"."createdAt" < ${cutoff}
    AND NOT ${captureImageHeldSql('"Image"')}
    AND NOT ${ownerHeldSql(Prisma.raw('"Image"."userId"'))}
  `;
}

/** The oldest captures past `cutoff` that nothing keeps. */
export function expiredCapturesSql(cutoff: Date, limit = BATCH_SIZE) {
  return Prisma.sql`
    SELECT i.id FROM "Image" i
    WHERE i."userId" = ${captureOwner}
      AND i."createdAt" < ${cutoff}
      AND NOT ${captureImageHeldSql('i')}
    ORDER BY i."createdAt" ASC, i.id ASC
    LIMIT ${limit}
  `;
}

/** The captures past `cutoff` that are kept, each with the states that keep it. */
export function keptCapturesSql(cutoff: Date) {
  const legs = Object.entries(captureHoldLegsSql('i')).map(
    ([leg, sql]) => Prisma.sql`${sql} AS ${Prisma.raw(`"${leg}"`)}`
  );
  return Prisma.sql`
    SELECT i.id, ${Prisma.join(legs)}
    FROM "Image" i
    WHERE i."userId" = ${captureOwner}
      AND i."createdAt" < ${cutoff}
      AND ${captureImageHeldSql('i')}
    ORDER BY i."createdAt" ASC, i.id ASC
  `;
}

type KeptRow = { id: number } & Record<CaptureHoldLeg, boolean>;

/** Per-run counts of what was kept, by each state that keeps a capture (one row can count twice). */
export function summarizeKept(rows: KeptRow[]) {
  return {
    kept: rows.length,
    keptReview: rows.filter((r) => r.review).length,
    keptBlocked: rows.filter((r) => r.blocked).length,
    keptMinor: rows.filter((r) => r.minor).length,
    keptReported: rows.filter((r) => r.reported).length,
    keptEvidenceHold: rows.filter((r) => r.evidenceHold).length,
    keptIds: rows.slice(0, KEPT_IDS_LOGGED).map((r) => r.id),
  };
}

/** Deletes feedback page captures past their retention window. */
export const purgeFeedbackCaptures = createJob(
  'purge-feedback-captures',
  '40 5 * * *',
  async () => {
    const cutoff = decreaseDate(new Date(), FEEDBACK_CAPTURE_RETENTION_DAYS, 'days');
    const expired = await dbWrite.$queryRaw<{ id: number }[]>(expiredCapturesSql(cutoff));
    const kept = summarizeKept(await dbWrite.$queryRaw<KeptRow[]>(keptCapturesSql(cutoff)));
    const ids = expired.map((r) => r.id);

    // A local run, or an app pointed at a non-prod copy, must never delete production media.
    if (!isProd || !env.DATABASE_IS_PROD) return { wouldDelete: ids.length, ...kept };

    const deleted = ids.length
      ? (await deleteImages(ids, true, { onlyWhere: feedbackCaptureDeleteGuard(cutoff) })).map(
          (r) => r.id
        )
      : [];
    const deletedSet = new Set(deleted);
    const skipped = ids.filter((id) => !deletedSet.has(id));
    const result = { deleted: deleted.length, skippedByGuard: skipped.length, ...kept };
    await logToAxiom({
      type: 'info',
      name: 'purge-feedback-captures',
      message: 'Purged expired feedback page captures',
      ...result,
      deletedIds: deleted,
      skippedIds: skipped,
    }).catch(() => undefined);
    return result;
  }
);
