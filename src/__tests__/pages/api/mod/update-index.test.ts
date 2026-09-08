import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateSync, processQueues } = vi.hoisted(() => ({
  updateSync: vi.fn(),
  processQueues: vi.fn().mockResolvedValue(undefined),
}));

// ModEndpoint wraps the handler in mod-auth; the handler itself is what is under test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

vi.mock('~/server/jobs/job', () => ({
  inJobContext: (_res: NextApiResponse, fn: (jobContext: unknown) => Promise<void>) => fn({}),
}));

// The real index objects open a Meilisearch client and hit the database at module load.
vi.mock('~/server/search-index', () => {
  const index = { updateSync, processQueues };
  return {
    modelsSearchIndex: index,
    usersSearchIndex: index,
    imagesSearchIndex: index,
    articlesSearchIndex: index,
    imagesMetricsSearchIndex: index,
    collectionsSearchIndex: index,
    bountiesSearchIndex: index,
    toolsSearchIndex: index,
    comicsSearchIndex: index,
  };
});

import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';
import handler from '~/pages/api/mod/update-index';

const runRequest = async (query: Record<string, string>) => {
  const req = {
    method: 'GET',
    query,
    headers: { host: 'localhost:3000' },
  } as unknown as NextApiRequest;

  const send = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnThis();
  const res = {
    status,
    send,
    json: vi.fn().mockReturnThis(),
    on: vi.fn(),
  } as unknown as NextApiResponse;

  await handler(req, res);

  return {
    status: status.mock.calls[0]?.[0] as number | undefined,
    body: send.mock.calls[0]?.[0] as Record<string, unknown> | undefined,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  processQueues.mockResolvedValue(undefined);
});

describe('/api/mod/update-index', () => {
  it('does NOT return 200 ok when a batch failed to index', async () => {
    updateSync.mockResolvedValue({
      indexName: COLLECTIONS_SEARCH_INDEX,
      totalTasks: 5,
      failedTasks: 4,
      failedIds: 1200,
    });

    const { status, body } = await runRequest({
      index: COLLECTIONS_SEARCH_INDEX,
      updateIds: '1,2,3',
    });

    expect(status).not.toBe(200);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body).toMatchObject({
      status: 'error',
      index: COLLECTIONS_SEARCH_INDEX,
      failedTasks: 4,
      failedIds: 1200,
    });
  });

  it('keeps the success response unchanged when every batch succeeded', async () => {
    updateSync.mockResolvedValue({
      indexName: COLLECTIONS_SEARCH_INDEX,
      totalTasks: 5,
      failedTasks: 0,
      failedIds: 0,
    });

    const { status, body } = await runRequest({
      index: COLLECTIONS_SEARCH_INDEX,
      updateIds: '1,2,3',
    });

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  it('routes the requested index to updateSync with the requested ids', async () => {
    updateSync.mockResolvedValue({
      indexName: COLLECTIONS_SEARCH_INDEX,
      totalTasks: 1,
      failedTasks: 0,
      failedIds: 0,
    });

    await runRequest({ index: COLLECTIONS_SEARCH_INDEX, updateIds: '7,8' });

    expect(updateSync).toHaveBeenCalledTimes(1);
    expect(updateSync.mock.calls[0][0]).toEqual([
      { id: 7, action: 'Update' },
      { id: 8, action: 'Update' },
    ]);
  });

  it('still returns 200 for a processQueues run, which reports no sync result', async () => {
    const { status, body } = await runRequest({
      index: COLLECTIONS_SEARCH_INDEX,
      processQueues: 'update',
    });

    expect(processQueues).toHaveBeenCalledTimes(1);
    expect(updateSync).not.toHaveBeenCalled();
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });
});
