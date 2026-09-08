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
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  UNRUNNABLE_JOB_CRON: '0 0 31 2 *',
}));

import { reindexRecentScheduledImages } from '~/server/jobs/reindex-recent-scheduled-images';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;

type JobResult = { reindexed: number; lastId: number; done: boolean };
const runJob = (query: Record<string, string> = {}) =>
  (reindexRecentScheduledImages as unknown as (ctx: { req?: NextApiRequest }) => Promise<JobResult>)(
    { req: { query } as unknown as NextApiRequest }
  );

const rows = (...ids: number[]) => ids.map((id) => ({ id }));

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.$queryRaw.mockResolvedValue(rows(1, 2));
});

describe('reindexRecentScheduledImages', () => {
  // images_v6 is the half that was never covered: the metrics index takes every image and
  // filters at query time, so a stale doc is merely mis-sorted there, while images_v6
  // rejects a future-dated post outright and the image is absent from site search.
  it('syncs both image indexes by default', async () => {
    await runJob();
    const data = rows(1, 2).map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }));
    expect(mockSearchSync).toHaveBeenCalledWith(data, expect.anything());
    expect(mockMetricsSync).toHaveBeenCalledWith(data, expect.anything());
  });

  it('syncs only the index named in `indexes`', async () => {
    await runJob({ indexes: 'search' });
    expect(mockSearchSync).toHaveBeenCalled();
    expect(mockMetricsSync).not.toHaveBeenCalled();
  });

  it('rejects an unknown index rather than silently syncing both', async () => {
    await expect(runJob({ indexes: 'bogus' })).rejects.toThrow();
    expect(mockSearchSync).not.toHaveBeenCalled();
    expect(mockMetricsSync).not.toHaveBeenCalled();
  });

  // The backfill spans far more images than one invocation should carry, so the operator
  // pages through it. A cursor that didn't advance would re-walk the head forever.
  it('reports the last id so the next run can resume past it', async () => {
    mockDbRead.$queryRaw.mockResolvedValue(rows(10, 20, 30));
    const result = await runJob({ limit: '3' });
    expect(result).toEqual({ reindexed: 3, lastId: 30, done: false });
  });

  it('reports done when the page comes back short', async () => {
    mockDbRead.$queryRaw.mockResolvedValue(rows(10));
    const result = await runJob({ limit: '3' });
    expect(result).toEqual({ reindexed: 1, lastId: 10, done: true });
  });

  it('passes the cursor and limit into the query', async () => {
    await runJob({ afterId: '500', limit: '250' });
    const args = mockDbRead.$queryRaw.mock.calls[0] as unknown[];
    expect(args).toContain(500);
    expect(args).toContain(250);
  });

  it('syncs nothing and stops when the page is empty', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);
    const result = await runJob();
    expect(mockSearchSync).not.toHaveBeenCalled();
    expect(mockMetricsSync).not.toHaveBeenCalled();
    expect(result).toEqual({ reindexed: 0, lastId: 0, done: true });
  });
});
