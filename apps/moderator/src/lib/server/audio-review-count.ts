import { sql } from '@civitai/db/kysely';
import { DEFAULT_REPORT_REASONS } from '$lib/reports';
import { dbRead } from './db';

/**
 * Pending reports on songs (`Image` type audio), the Reported tab of Audio review. The reasons are
 * the ones Image reports counts (`DEFAULT_REPORT_REASONS`), so a report is in exactly one of the two
 * queues. Kept apart from `audio-review.service.ts` so the sidebar counts import no more than this.
 */
export const pendingSongReports = () =>
  dbRead
    .selectFrom('Report as r')
    .innerJoin('ImageReport as ir', 'ir.reportId', 'r.id')
    .innerJoin('Image as i', 'i.id', 'ir.imageId')
    .where('r.status', '=', 'Pending')
    .where('r.reason', 'in', DEFAULT_REPORT_REASONS)
    .where('i.type', '=', 'audio');

/** The sidebar badge: songs with a Pending report, and those reports (Image reports' badge drops
 *  them, as its queue does). */
export async function countReportedSongs(): Promise<{ songs: number; reports: number }> {
  const row = await pendingSongReports()
    .select([
      sql<number>`count(DISTINCT i.id)::int`.as('songs'),
      sql<number>`count(*)::int`.as('reports'),
    ])
    .executeTakeFirst();
  return { songs: row?.songs ?? 0, reports: row?.reports ?? 0 };
}
