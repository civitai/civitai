import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One mock per export, each with its OWN spies. Sharing a single object across all nine made the
 * lookup table in the handler unobservable: any index could be mapped to any other and every
 * assertion still passed.
 */
const { indexMocks } = vi.hoisted(() => {
  const exportNames = [
    'modelsSearchIndex',
    'usersSearchIndex',
    'imagesSearchIndex',
    'articlesSearchIndex',
    'imagesMetricsSearchIndex',
    'collectionsSearchIndex',
    'bountiesSearchIndex',
    'toolsSearchIndex',
    'comicsSearchIndex',
  ] as const;

  type ExportName = (typeof exportNames)[number];
  const mocks = {} as Record<
    ExportName,
    { updateSync: ReturnType<typeof vi.fn>; processQueues: ReturnType<typeof vi.fn> }
  >;
  for (const name of exportNames) {
    mocks[name] = { updateSync: vi.fn(), processQueues: vi.fn() };
  }
  return { indexMocks: mocks };
});

type IndexExportName = keyof typeof indexMocks;
const indexExportNames = Object.keys(indexMocks) as IndexExportName[];

// ModEndpoint wraps the handler in mod-auth; the handler itself is what is under test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

vi.mock('~/server/jobs/job', () => ({
  inJobContext: (_res: NextApiResponse, fn: (jobContext: unknown) => Promise<void>) => fn({}),
}));

// The real index objects open a Meilisearch client and hit the database at module load.
vi.mock('~/server/search-index', () => indexMocks);

import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  METRICS_IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import handler from '~/pages/api/mod/update-index';

/**
 * The routing this file pins: every `index` query value and the module export that must handle
 * it. Written out by hand rather than derived from the handler, so a copy-paste slip in the
 * handler's lookup table disagrees with it instead of being mirrored by it.
 */
const expectedRouting: Array<{ index: string; exportName: IndexExportName }> = [
  { index: MODELS_SEARCH_INDEX, exportName: 'modelsSearchIndex' },
  { index: USERS_SEARCH_INDEX, exportName: 'usersSearchIndex' },
  { index: IMAGES_SEARCH_INDEX, exportName: 'imagesSearchIndex' },
  { index: ARTICLES_SEARCH_INDEX, exportName: 'articlesSearchIndex' },
  { index: METRICS_IMAGES_SEARCH_INDEX, exportName: 'imagesMetricsSearchIndex' },
  { index: COLLECTIONS_SEARCH_INDEX, exportName: 'collectionsSearchIndex' },
  { index: BOUNTIES_SEARCH_INDEX, exportName: 'bountiesSearchIndex' },
  { index: TOOLS_SEARCH_INDEX, exportName: 'toolsSearchIndex' },
  { index: COMICS_SEARCH_INDEX, exportName: 'comicsSearchIndex' },
];

const updateSync = indexMocks.collectionsSearchIndex.updateSync;
const processQueues = indexMocks.collectionsSearchIndex.processQueues;

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
  for (const name of indexExportNames) {
    indexMocks[name].processQueues.mockResolvedValue(undefined);
    indexMocks[name].updateSync.mockResolvedValue({
      indexName: name,
      totalTasks: 1,
      failedTasks: 0,
      failedIds: 0,
    });
  }
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

  describe.each(expectedRouting)('index routing :: $index', ({ index, exportName }) => {
    it(`sends updateSync to ${exportName} and to no other index`, async () => {
      await runRequest({ index, updateIds: '7,8' });

      expect(
        indexMocks[exportName].updateSync,
        `index "${index}" should have been routed to ${exportName}`
      ).toHaveBeenCalledTimes(1);

      const misrouted = indexExportNames.filter(
        (name) => name !== exportName && indexMocks[name].updateSync.mock.calls.length > 0
      );
      expect(misrouted, `index "${index}" was ALSO routed to: ${misrouted.join(', ')}`).toEqual([]);
    });

    it(`sends processQueues to ${exportName} and to no other index`, async () => {
      await runRequest({ index, processQueues: 'update' });

      expect(
        indexMocks[exportName].processQueues,
        `index "${index}" should have been routed to ${exportName}`
      ).toHaveBeenCalledTimes(1);

      const misrouted = indexExportNames.filter(
        (name) => name !== exportName && indexMocks[name].processQueues.mock.calls.length > 0
      );
      expect(misrouted, `index "${index}" was ALSO routed to: ${misrouted.join(', ')}`).toEqual([]);
    });
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
