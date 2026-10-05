import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';

export const AUTOMATED_REPORT_RETENTION_DAYS = 14;

// Unactioned is what a moderator dismissal looks like too; this note is how the lookup pages tell them apart.
export const EXPIRED_AUTOMATED_REPORT_NOTE =
  'Expired unreviewed: the Clavata evidence was deleted after 14 days.';

/**
 * Deletes the Clavata evidence for Automated reports past retention, closing each report it strips.
 * A report left Pending without its evidence can never be reviewed, which is how 1.29M accumulated.
 *
 * Keyed on the evidence row, not on report age: an age rule would also sweep the pre-existing
 * evidence-less backlog, and closing that is a separate, approved one-off write.
 */
export async function clearAutomatedReports(cutoff: Date) {
  const closed = await dbWrite.$executeRaw`
    UPDATE "Report" r
    SET status = ${ReportStatus.Unactioned}::"ReportStatus",
        "statusSetAt" = now(),
        "statusSetBy" = ${constants.system.user.id},
        "internalNotes" = concat_ws(' | ', r."internalNotes", ${EXPIRED_AUTOMATED_REPORT_NOTE}::text)
    FROM "ReportAutomated" ra
    WHERE ra."reportId" = r.id
      AND ra."createdAt" < ${cutoff}
      AND r.reason = ${ReportReason.Automated}::"ReportReason"
      AND r.status = ${ReportStatus.Pending}::"ReportStatus"
  `;

  const deleted = await dbWrite.$executeRaw`
    DELETE FROM "ReportAutomated" WHERE "createdAt" < ${cutoff}
  `;

  return { closed, deleted };
}
