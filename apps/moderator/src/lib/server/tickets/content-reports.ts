import type { getReportsReceived } from '../user-reports.service';
import type { getImageRemovals } from '../user-account.service';
import { DEFAULT_REPORT_REASONS } from '$lib/reports';
import { CONTENT_ROWS, IMAGE_REMOVALS_PATH, USER_REPORTS_PATH } from '$lib/tickets/content-panel';
import { toVisibleRemovals, type HistoryRemoval } from './history';
import { capped, section, type CardSection } from './section';

export type ContentReport = {
  id: number;
  reason: string;
  status: string;
  createdAt: string;
  reporter: string | null;
};

export type TicketContentIssue =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | {
      status: 'ok';
      userId: number;
      /** Left out when the viewer does not hold the report queues' page grant. */
      reports?: CardSection<ContentReport>;
      /** Left out when the viewer does not hold User Lookup's page grant. */
      removals?: CardSection<HistoryRemoval>;
    };

export type ContentIssueReads = {
  /** Reports filed against content the user owns. */
  reportsReceived: (userId: number, limit: number) => ReturnType<typeof getReportsReceived>;
  removals: (
    userId: number,
    limit: number
  ) => Promise<Pick<Awaited<ReturnType<typeof getImageRemovals>>, 'rows' | 'next'>>;
};

// Imported when read, so loading the ticket detail module opens no database or ClickHouse connection.
const liveReads: ContentIssueReads = {
  // Open reports on the user's content, human reasons only: what is outstanding, not the Automated flood
  // that the report queues also hide by default.
  reportsReceived: async (userId, limit) =>
    (await import('../user-reports.service')).getReportsReceived(userId, {
      limit,
      statuses: ['Pending', 'Processing'],
      reasons: DEFAULT_REPORT_REASONS,
    }),
  removals: async (userId, limit) =>
    (await import('../user-account.service')).getImageRemovals(userId, undefined, limit),
};

/**
 * Open reports on the linked user's content and their image removals, each bounded and read only under its own source
 * page's grant. Read-only: the report queue and User Lookup hold the whole record.
 */
export async function contentIssueSectionFor(
  ticket: { userId: number; canRead: (path: string) => boolean },
  reads: ContentIssueReads = liveReads
): Promise<Extract<TicketContentIssue, { status: 'ok' }>> {
  const { userId, canRead } = ticket;
  const [reports, removals] = await Promise.all([
    canRead(USER_REPORTS_PATH)
      ? section('content', 'reports', async () =>
          capped(
            await reads.reportsReceived(userId, CONTENT_ROWS + 1),
            CONTENT_ROWS,
            (r): ContentReport => ({
              id: r.id,
              reason: r.reason,
              status: r.status,
              createdAt: r.createdAt.toISOString(),
              reporter: r.reporter,
            })
          )
        )
      : undefined,
    canRead(IMAGE_REMOVALS_PATH)
      ? section('content', 'removals', async () => {
          const { rows, next } = await reads.removals(userId, CONTENT_ROWS);
          return {
            truncated: next !== null,
            rows: toVisibleRemovals(rows),
          };
        })
      : undefined,
  ]);
  return {
    status: 'ok',
    userId,
    ...(reports ? { reports } : {}),
    ...(removals ? { removals } : {}),
  };
}
