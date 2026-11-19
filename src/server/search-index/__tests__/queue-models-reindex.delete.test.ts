import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';

// The Redis queues, in memory: the real index, SearchIndexUpdate and queueModelsReindex run on top.
const { queues } = vi.hoisted(() => ({ queues: new Map<string, number[]>() }));
vi.mock('~/server/redis/queues', () => ({
  addToQueue: async (key: string, ids: number[]) => {
    queues.set(key, [...new Set([...(queues.get(key) ?? []), ...ids])]);
    return true;
  },
  checkoutQueue: async (key: string) => ({
    content: [...(queues.get(key) ?? [])],
    commit: async () => void queues.delete(key),
  }),
}));

const { queueModelsReindex } = await import('~/server/search-index/queue-models-reindex');

const queued = (action: SearchIndexUpdateQueueAction) =>
  queues.get(`${MODELS_SEARCH_INDEX}:${action}`) ?? [];

beforeEach(() => queues.clear());

describe('queueModelsReindex with Delete', () => {
  it('queues the ids for deletion and reads the Delete queue back', async () => {
    queues.set(`${MODELS_SEARCH_INDEX}:${SearchIndexUpdateQueueAction.Delete}`, [9]);

    const result = await queueModelsReindex(
      [1, 2, 9],
      { dryRun: false, chunkSize: 2 },
      SearchIndexUpdateQueueAction.Delete
    );

    expect(queued(SearchIndexUpdateQueueAction.Delete)).toEqual([9, 1, 2]);
    expect(queued(SearchIndexUpdateQueueAction.Update)).toEqual([]);
    expect(result).toEqual({
      dryRun: false,
      modelCount: 3,
      queueDepthBefore: 1,
      queueDepthAfter: 3,
      landed: 3,
    });
  });

  it('a dry run counts against the Delete queue and queues nothing', async () => {
    queues.set(`${MODELS_SEARCH_INDEX}:${SearchIndexUpdateQueueAction.Delete}`, [2]);
    queues.set(`${MODELS_SEARCH_INDEX}:${SearchIndexUpdateQueueAction.Update}`, [1, 2]);

    const result = await queueModelsReindex(
      [1, 2],
      { dryRun: true, chunkSize: 1000 },
      SearchIndexUpdateQueueAction.Delete
    );

    expect(result).toEqual({ dryRun: true, modelCount: 2, queueDepthBefore: 1, alreadyQueued: 1 });
    expect(queued(SearchIndexUpdateQueueAction.Delete)).toEqual([2]);
  });
});
