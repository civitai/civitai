import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetQueue, mockCleanup, mockSetLastUpdate } = vi.hoisted(() => ({
  mockGetQueue: vi.fn(),
  mockCleanup: vi.fn(),
  mockSetLastUpdate: vi.fn(),
}));

vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { getQueue: mockGetQueue, queueUpdate: vi.fn(), clearQueue: vi.fn() },
}));
vi.mock('~/server/meilisearch/util', () => ({
  onSearchIndexDocumentsCleanup: mockCleanup,
  getOrCreateIndex: vi.fn(async () => ({})),
  swapIndex: vi.fn(),
}));
vi.mock('~/server/jobs/job', () => ({
  getJobDate: async () => [new Date(0), mockSetLastUpdate] as const,
}));

import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const QUEUED_ID = 42;

// Ordered log of the two things whose relative order is the whole subject here: the
// Meilisearch delete, and the upsert the pull path produces for the same id.
let calls: string[] = [];

// `qualifies` stands in for the index's own WHERE, which every real pullData applies —
// that is what makes delete-then-pull safe rather than merely a different guess.
const buildProcessor = ({ qualifies }: { qualifies: boolean }) => ({
  indexName: 'test_index',
  setup: async () => undefined,
  prepareBatches: async () => ({ batchSize: 100, startId: 1, endId: 0, updateIds: [] }),
  pullData: async (_ctx: unknown, batch: { type: string; ids?: number[] }) => {
    calls.push(`pull:${batch.ids?.join(',') ?? 'range'}`);
    return qualifies ? [{ id: QUEUED_ID }] : null;
  },
  transformData: async (data: unknown) => data,
  pushData: async (_ctx: unknown, data: { id: number }[]) => {
    calls.push(`push:${data.map((d) => d.id).join(',')}`);
  },
  workerCount: 1,
  client: {} as never,
});

const stubQueues = ({ updates, deletes }: { updates: number[]; deletes: number[] }) => {
  mockGetQueue.mockImplementation(async (_index: string, action: SearchIndexUpdateQueueAction) => ({
    content: action === SearchIndexUpdateQueueAction.Delete ? deletes : updates,
    commit: async () => undefined,
  }));
};

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  mockCleanup.mockImplementation(async ({ ids }: { ids: number[] }) => {
    calls.push(`delete:${ids.join(',')}`);
  });
});

// The Update and Delete queues are disjoint Redis sets with no timestamps, so an id in
// both carries no record of which action came last. Whichever side the drain resolves
// second wins. Resolving it as delete-then-pull hands the decision to the database.
describe('search index :: doubly-queued id', () => {
  it('rebuilds a restored document instead of deleting it, in update()', async () => {
    stubQueues({ updates: [QUEUED_ID], deletes: [QUEUED_ID] });
    const index = createSearchIndexUpdateProcessor(buildProcessor({ qualifies: true }));

    await index.update({} as never);

    expect(calls).toEqual([`delete:${QUEUED_ID}`, `pull:${QUEUED_ID}`, `push:${QUEUED_ID}`]);
  });

  it('leaves the document deleted when the row no longer qualifies', async () => {
    stubQueues({ updates: [QUEUED_ID], deletes: [QUEUED_ID] });
    const index = createSearchIndexUpdateProcessor(buildProcessor({ qualifies: false }));

    await index.update({} as never);

    expect(calls).toEqual([`delete:${QUEUED_ID}`, `pull:${QUEUED_ID}`]);
    expect(calls.some((c) => c.startsWith('push'))).toBe(false);
  });

  it('rebuilds a restored document instead of deleting it, in processQueues()', async () => {
    stubQueues({ updates: [QUEUED_ID], deletes: [QUEUED_ID] });
    const index = createSearchIndexUpdateProcessor(buildProcessor({ qualifies: true }));

    await index.processQueues({ processUpdates: true, processDeletes: true }, {} as never);

    expect(calls).toEqual([`delete:${QUEUED_ID}`, `pull:${QUEUED_ID}`, `push:${QUEUED_ID}`]);
  });
});

describe('search index :: single-action ids are unaffected', () => {
  it('still deletes an id queued only for deletion', async () => {
    stubQueues({ updates: [], deletes: [QUEUED_ID] });
    const index = createSearchIndexUpdateProcessor(buildProcessor({ qualifies: false }));

    await index.update({} as never);

    expect(calls).toEqual([`delete:${QUEUED_ID}`]);
  });

  it('still upserts an id queued only for update', async () => {
    stubQueues({ updates: [QUEUED_ID], deletes: [] });
    const index = createSearchIndexUpdateProcessor(buildProcessor({ qualifies: true }));

    await index.update({} as never);

    expect(mockCleanup).not.toHaveBeenCalled();
    expect(calls).toEqual([`pull:${QUEUED_ID}`, `push:${QUEUED_ID}`]);
  });
});
