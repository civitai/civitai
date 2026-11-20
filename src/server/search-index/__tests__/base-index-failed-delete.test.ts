import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const { queues, requeued } = vi.hoisted(() => ({
  queues: { Update: [] as number[], Delete: [] as number[] },
  requeued: [] as { id: number; action?: string }[][],
}));

vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: {
    getQueue: async (_index: string, action: 'Update' | 'Delete') => ({
      content: queues[action],
      commit: async () => undefined,
    }),
    queueUpdate: async ({ items }: { items: { id: number; action?: string }[] }) => {
      requeued.push(items);
      return true;
    },
    clearQueue: async () => undefined,
  },
}));
vi.mock('~/server/jobs/job', () => ({
  getJobDate: async () => [new Date(0), async () => undefined] as const,
}));

import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';

const ID = 42;

// Meilisearch accepts the delete, but the task fails.
const failingDeleteClient = {
  getIndex: async () => ({ deleteDocuments: async () => ({ taskUid: 1 }) }),
  waitForTasks: async () => [{ uid: 1, status: 'failed', error: { message: 'boom' } }],
};

// `qualifies`: the pull query still matches the id, as it can for content removed for a reason the
// query does not encode.
const processor = () =>
  createSearchIndexUpdateProcessor({
    indexName: 'test_index',
    setup: async () => undefined,
    prepareBatches: async () => ({ batchSize: 100, startId: 1, endId: 0, updateIds: [] }),
    pullData: async () => [{ id: ID }],
    transformData: async (data: unknown) => data,
    pushData: async () => undefined,
    workerCount: 1,
    client: failingDeleteClient as never,
  } as never);

const actions = () => requeued.flat().map((i) => i.action);

// updateSync's idle workers poll every 1s; drive the clock instead of waiting.
const settle = async <T>(promise: Promise<T>): Promise<T> => {
  let done = false;
  void promise.finally(() => (done = true)).catch(() => undefined);
  while (!done) await vi.advanceTimersByTimeAsync(1000);
  return promise;
};

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  queues.Update = [];
  queues.Delete = [];
  requeued.length = 0;
});

describe('search index :: a delete whose task fails', () => {
  it('goes back as a Delete only when the run does not rebuild the id', async () => {
    queues.Delete = [ID];
    await processor().update({} as never);
    expect(actions()).toEqual([SearchIndexUpdateQueueAction.Delete]);
  });

  it('goes back as a Delete and an Update when the same update() run rebuilds it', async () => {
    queues.Delete = [ID];
    queues.Update = [ID];
    await processor().update({} as never);
    expect(actions()).toEqual([
      SearchIndexUpdateQueueAction.Delete,
      SearchIndexUpdateQueueAction.Update,
    ]);
  });

  it('goes back as a Delete only from processQueues(), even when the id is also queued for update', async () => {
    queues.Delete = [ID];
    queues.Update = [ID];
    await processor().processQueues({ processDeletes: true, processUpdates: true }, {} as never);
    expect(actions()).toEqual([SearchIndexUpdateQueueAction.Delete]);
  });

  it('goes back as a Delete only from updateSync() when the call does not rebuild the id', async () => {
    await settle(
      processor().updateSync([
        { id: ID, action: SearchIndexUpdateQueueAction.Delete },
        { id: ID + 1, action: SearchIndexUpdateQueueAction.Update },
      ])
    );
    expect(requeued.flat()).toEqual([{ id: ID, action: SearchIndexUpdateQueueAction.Delete }]);
  });

  it('goes back as a Delete and an Update from updateSync() when the same call rebuilds it', async () => {
    await settle(
      processor().updateSync([
        { id: ID, action: SearchIndexUpdateQueueAction.Delete },
        { id: ID, action: SearchIndexUpdateQueueAction.Update },
      ])
    );
    expect(actions()).toEqual([
      SearchIndexUpdateQueueAction.Delete,
      SearchIndexUpdateQueueAction.Update,
    ]);
  });
});
