import { sql } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { kyselyWrite } from './infra/client';

// The `Report.status` enum, derived from the schema so this module needs no separate enum import.
type ReportStatusValue = DB['Report']['status'];

// The status-transition SET clause. On Actioned, stamp how many reporters the report resolved.
const statusSet = (status: ReportStatusValue, userId: number) => ({
  status,
  statusSetAt: new Date(),
  statusSetBy: userId,
  ...(status === 'Actioned'
    ? { previouslyReviewedCount: sql<number>`coalesce(array_length("alsoReportedBy", 1), 0) + 1` }
    : {}),
});

// Transition one report; RETURNs the reporters only if the row actually changed (the `status != next`
// guard), so a caller can reward exactly once — a no-op re-transition returns undefined. Used by the
// moderator spoke. Follow-on side effects (rewards, activity) stay with the caller.
export function setReportStatus(input: { id: number; status: ReportStatusValue; userId: number }) {
  return kyselyWrite
    .updateTable('Report')
    .set(statusSet(input.status, input.userId))
    .where('id', '=', input.id)
    .where('status', '!=', input.status)
    .returning(['userId', 'alsoReportedBy'])
    .executeTakeFirst();
}

// Bulk variant: transition many reports in one atomic statement (no explicit transaction needed) and RETURN
// the changed rows' id + reporters. Used by the main app's bulkSetReportStatus.
export async function setReportStatusMany(input: {
  ids: number[];
  status: ReportStatusValue;
  userId: number;
}) {
  if (!input.ids.length) return [];
  return kyselyWrite
    .updateTable('Report')
    .set(statusSet(input.status, input.userId))
    .where('id', 'in', input.ids)
    .where('status', '!=', input.status)
    .returning(['id', 'userId', 'alsoReportedBy'])
    .execute();
}
