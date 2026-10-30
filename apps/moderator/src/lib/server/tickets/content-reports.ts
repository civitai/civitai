import type { getReportsReceived } from '../user-reports.service';
import type { getImageRemovals } from '../user-account.service';
import { DEFAULT_REPORT_REASONS } from '$lib/reports';
import { CONTENT_ROWS, IMAGE_REMOVALS_PATH, USER_REPORTS_PATH } from '$lib/tickets/content-panel';
import { toVisibleRemovals, type HistoryRemoval, type HistorySection } from './history';

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
      reports?: HistorySection<ContentReport>;
      /** Left out when the viewer does not hold User Lookup's page grant. */
      removals?: HistorySection<HistoryRemoval>;
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

/** One section: a failing read is that section's `unavailable`, never the card's. */
async function section<T>(
  label: string,
  read: () => Promise<{ rows: T[]; truncated: boolean }>
): Promise<HistorySection<T>> {
  try {
    return { status: 'ok', ...(await read()) };
  } catch (e) {
    console.error(`[tickets] content ${label} failed`, e);
    return { status: 'unavailable' };
  }
}

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
      ? section('reports', async () => {
          const rows = await reads.reportsReceived(userId, CONTENT_ROWS + 1);
          return {
            truncated: rows.length > CONTENT_ROWS,
            rows: rows.slice(0, CONTENT_ROWS).map(
              (r): ContentReport => ({
                id: r.id,
                reason: r.reason,
                status: r.status,
                createdAt: r.createdAt.toISOString(),
                reporter: r.reporter,
              })
            ),
          };
        })
      : undefined,
    canRead(IMAGE_REMOVALS_PATH)
      ? section('removals', async () => {
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
