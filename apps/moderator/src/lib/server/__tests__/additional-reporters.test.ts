import { describe, expect, it, vi } from 'vitest';

/**
 * A report filed by several people is one row; the others ride in `details.additionalReports`, each
 * with its own words and a user id. The layout queues (user, model, post and the shared entity route — `ReportList`) show every
 * reporter's comment, so the folding has to
 * survive whatever shape the jsonb arrives in.
 */

const usersByIds = vi.fn(
  async (ids: number[]) => new Map(ids.map((id) => [id, { username: `u${id}` }]))
);
vi.mock('../users.service', () => ({ MAX_INT4: 2_147_483_647, usersByIds }));
vi.mock('../reports.service', () => ({ getReports: vi.fn(), getReportStatusCounts: vi.fn() }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { withAdditionalReporters } = await import('../report-queue-load');

describe('withAdditionalReporters', () => {
  it('names each other reporter and keeps their own words', async () => {
    const [row] = await withAdditionalReporters([
      {
        id: 1,
        details: {
          comment: 'spam links',
          additionalReports: [
            {
              userId: 7,
              details: { comment: 'gambling site' },
              createdAt: '2026-10-11T23:04:02.507Z',
            },
            { userId: 8, details: { violation: 'Child abuse and exploitation' } },
            { userId: 9, details: {} },
          ],
        },
      },
    ]);

    expect(row.additionalReporters).toEqual([
      {
        userId: 7,
        username: 'u7',
        createdAt: '2026-10-11T23:04:02.507Z',
        comment: 'gambling site',
      },
      { userId: 8, username: 'u8', createdAt: null, comment: 'Child abuse and exploitation' },
      { userId: 9, username: 'u9', createdAt: null, comment: null },
    ]);
  });

  it('reads nothing for a report filed once, and survives details that are not an object', async () => {
    usersByIds.mockClear();
    const rows = await withAdditionalReporters([
      { id: 1, details: { comment: 'x' } },
      { id: 2, details: null },
      { id: 3, details: { additionalReports: 'not a list' } },
    ]);

    expect(rows.map((r) => r.additionalReporters)).toEqual([[], [], []]);
    expect(usersByIds).not.toHaveBeenCalled();
  });
});
