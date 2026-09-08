import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSearchSync, mockMetricsSync } = vi.hoisted(() => ({
  mockSearchSync: vi.fn(),
  mockMetricsSync: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  imagesSearchIndex: { updateSync: mockSearchSync },
  imagesMetricsSearchIndex: { updateSync: mockMetricsSync },
}));

// NOTE: `~/server/jobs/job` is deliberately NOT mocked here. The point of this file is the
// link the other suite cannot see: whether the real createJob harness actually carries
// `req` through to the job body, so `?indexes=` reaches the schema.
import { reindexRecentScheduledImages } from '~/server/jobs/reindex-recent-scheduled-images';
import { dbMock } from '~/__tests__/mocks/db.mock';

const runViaHarness = (query: Record<string, string>) =>
  reindexRecentScheduledImages.run({ req: { query } as unknown as NextApiRequest }).result;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: 1, publishedAt: new Date() }]);
});

describe('reindex-recent-scheduled-images :: query param wiring through createJob', () => {
  it('honours ?indexes=search through the real job harness', async () => {
    await runViaHarness({ indexes: 'search' });
    expect(mockSearchSync).toHaveBeenCalledTimes(1);
    expect(mockMetricsSync).not.toHaveBeenCalled();
  });

  it('honours ?indexes=metrics through the real job harness', async () => {
    await runViaHarness({ indexes: 'metrics' });
    expect(mockMetricsSync).toHaveBeenCalledTimes(1);
    expect(mockSearchSync).not.toHaveBeenCalled();
  });

  it('defaults to both when no indexes param is given', async () => {
    await runViaHarness({});
    expect(mockSearchSync).toHaveBeenCalledTimes(1);
    expect(mockMetricsSync).toHaveBeenCalledTimes(1);
  });

  it('carries the paging cursor and limit into the query too', async () => {
    const at = new Date('2026-08-20T00:00:00.000Z');
    await runViaHarness({
      indexes: 'search',
      beforeAt: at.toISOString(),
      beforeId: '77',
      limit: '250',
    });
    const args = dbMock.dbRead.$queryRaw.mock.calls[0] as unknown[];
    expect(args).toContainEqual(at);
    expect(args).toContain(77);
    expect(args).toContain(250);
  });
});
