import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeiliSearch } from 'meilisearch';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const queued = vi.hoisted(() => ({ calls: [] as unknown[], deleteQueue: [] as number[] }));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: {
    queueUpdate: async (args: unknown) => {
      queued.calls.push(args);
      return true;
    },
    getQueue: async () => ({ content: queued.deleteQueue, commit: async () => undefined }),
  },
}));

import { onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';

/** A client whose one delete task ends with `status`, or whose wait throws when `status` is an Error. */
const clientWhoseDeleteEnds = (status: string | Error) =>
  ({
    getIndex: async () => ({ deleteDocuments: async () => ({ taskUid: 7 }) }),
    waitForTasks: async () => {
      if (status instanceof Error) throw status;
      return [{ uid: 7, status, error: status === 'failed' ? { message: 'boom' } : null }];
    },
  } as unknown as MeiliSearch);

const requeuedDeletes = () =>
  queued.calls.map((c) => (c as { items: { id: number; action: string }[] }).items);

beforeEach(() => {
  queued.calls = [];
  queued.deleteQueue = [];
});

describe('onSearchIndexDocumentsCleanup when the delete task fails', () => {
  it('re-queues the given ids as deletes', async () => {
    await onSearchIndexDocumentsCleanup({
      indexName: 'idx',
      ids: [1, 2],
      client: clientWhoseDeleteEnds('failed'),
    });
    expect(requeuedDeletes()).toEqual([
      [
        { id: 1, action: SearchIndexUpdateQueueAction.Delete },
        { id: 2, action: SearchIndexUpdateQueueAction.Delete },
      ],
    ]);
  });

  it('re-queues the queued ids it took off the Delete queue', async () => {
    queued.deleteQueue = [5];
    await onSearchIndexDocumentsCleanup({
      indexName: 'idx',
      client: clientWhoseDeleteEnds('failed'),
    });
    expect(requeuedDeletes()).toEqual([[{ id: 5, action: SearchIndexUpdateQueueAction.Delete }]]);
  });

  it('re-queues when the wait itself fails', async () => {
    await onSearchIndexDocumentsCleanup({
      indexName: 'idx',
      ids: [3],
      client: clientWhoseDeleteEnds(new Error('connection reset')),
    });
    expect(requeuedDeletes()).toEqual([[{ id: 3, action: SearchIndexUpdateQueueAction.Delete }]]);
  });

  it('re-queues nothing when the task succeeds', async () => {
    await onSearchIndexDocumentsCleanup({
      indexName: 'idx',
      ids: [1, 2],
      client: clientWhoseDeleteEnds('succeeded'),
    });
    expect(queued.calls).toEqual([]);
  });
});
