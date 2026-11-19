import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MeiliSearchTimeOutError, type MeiliSearch } from 'meilisearch';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const queued = vi.hoisted(() => ({
  calls: [] as unknown[],
  deleteQueue: [] as number[],
  onQueue: (() => undefined) as () => unknown,
  commits: 0,
}));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: {
    queueUpdate: async (args: unknown) => {
      queued.calls.push(args);
      queued.onQueue();
      return true;
    },
    getQueue: async () => ({
      content: queued.deleteQueue,
      commit: async () => void (queued.commits += 1),
    }),
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
  queued.onQueue = () => undefined;
  queued.commits = 0;
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

  it('commits the checkout the ids came from before re-queueing them', async () => {
    const order: string[] = [];
    queued.onQueue = () => order.push('requeue');
    await onSearchIndexDocumentsCleanup({
      indexName: 'idx',
      ids: [4],
      client: clientWhoseDeleteEnds('failed'),
      commit: async () => void order.push('commit'),
    });
    expect(order).toEqual(['commit', 'requeue']);
  });

  it('re-queues under the index it was deleting from', async () => {
    await onSearchIndexDocumentsCleanup({
      indexName: 'comics',
      ids: [1],
      client: clientWhoseDeleteEnds('failed'),
    });
    expect(queued.calls).toMatchObject([{ indexName: 'comics' }]);
  });

  it('commits the Delete queue it drained, whether or not the delete succeeds', async () => {
    queued.deleteQueue = [5];
    await onSearchIndexDocumentsCleanup({
      indexName: 'idx',
      client: clientWhoseDeleteEnds('failed'),
    });
    await onSearchIndexDocumentsCleanup({
      indexName: 'idx',
      client: clientWhoseDeleteEnds('succeeded'),
    });
    expect(queued.commits).toBe(2);
  });

  it('keeps waiting on the same client after a wait times out', async () => {
    let waits = 0;
    const client = {
      getIndex: async () => ({ deleteDocuments: async () => ({ taskUid: 7 }) }),
      waitForTasks: async () => {
        waits += 1;
        if (waits === 1) throw new MeiliSearchTimeOutError('slow');
        return [{ uid: 7, status: 'succeeded', error: null }];
      },
    } as unknown as MeiliSearch;
    await onSearchIndexDocumentsCleanup({ indexName: 'idx', ids: [1], client });
    expect(waits).toBe(2);
    expect(queued.calls).toEqual([]);
  });
});
