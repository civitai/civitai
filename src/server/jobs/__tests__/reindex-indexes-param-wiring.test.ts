import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMetricsSync } = vi.hoisted(() => ({
  mockMetricsSync: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  imagesMetricsSearchIndex: { updateSync: mockMetricsSync },
}));

// NOTE: `~/server/jobs/job` is deliberately NOT mocked here. The point of this file is the
// link the other suite cannot see: whether the real createJob harness actually carries
// `req` through to the job body, so the query params reach the schema.
import { reindexRecentScheduledImages } from '~/server/jobs/reindex-recent-scheduled-images';
import { dbMock } from '~/__tests__/mocks/db.mock';

const runViaHarness = (query: Record<string, string>) =>
  reindexRecentScheduledImages.run({ req: { query } as unknown as NextApiRequest }).result;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: 1, publishedAt: new Date() }]);
});

describe('reindex-recent-scheduled-images :: query param wiring through createJob', () => {
  it('carries the paging cursor and limit into the query too', async () => {
    const at = new Date('2026-08-20T00:00:00.000Z');
    await runViaHarness({
      beforeAt: at.toISOString(),
      beforeId: '77',
      limit: '250',
    });
    // The cursor arrives as a nested Prisma.sql fragment, so flatten one level before
    // asserting or this passes against a query that dropped it.
    const [, ...values] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const flat = values.flatMap((v) =>
      v && typeof v === 'object' && Array.isArray((v as { values?: unknown[] }).values)
        ? ((v as { values: unknown[] }).values as unknown[])
        : [v]
    );
    expect(flat).toContainEqual(at);
    expect(flat).toContain(77);
    expect(flat).toContain(250);
  });
});
