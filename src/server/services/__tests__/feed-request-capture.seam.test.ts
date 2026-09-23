import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drives the real getImagesFromSearch: a capture service nothing invokes stays green otherwise.

import type * as MeilisearchClient from '~/server/meilisearch/client';
import type * as CaptureService from '~/server/services/feed-request-capture.service';

const { fetchDocumentsAbortableMock, recordMock } = vi.hoisted(() => ({
  fetchDocumentsAbortableMock: vi.fn(),
  recordMock: vi.fn(async () => undefined),
}));

vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return {
    ...actual,
    metricsSearchClient: {},
    getMetricsSearchClient: () => ({}),
    fetchDocumentsAbortable: fetchDocumentsAbortableMock,
  };
});

vi.mock('~/server/services/feed-request-capture.service', async (importOriginal) => {
  const actual = await importOriginal<typeof CaptureService>();
  return {
    ...actual,
    feedRequestCapture: () => ({
      record: recordMock,
      flush: async () => undefined,
      pending: 0,
      dropped: 0,
    }),
  };
});

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { getImagesFromSearch } from '../image.service';

const searchInput = {
  userId: 999,
  currentUserId: 4321,
  isModerator: false,
  limit: 20,
  period: 'AllTime',
  sort: 'Newest',
  browsingLevel: 31,
  include: ['tagIds'],
  headers: { src: 'getInfiniteImagesHandler' },
};

describe('getImagesFromSearch → feedRequestCapture seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the failed search with the input, the dispatch source and error set', async () => {
    fetchDocumentsAbortableMock.mockRejectedValue(new Error('meili exploded'));
    type SearchArg = Parameters<typeof getImagesFromSearch>[0];
    await expect(getImagesFromSearch(searchInput as unknown as SearchArg)).rejects.toThrow(
      'meili exploded'
    );
    expect(recordMock).toHaveBeenCalledTimes(1);
    const [input, outcome] = recordMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>
    ];
    expect(input.userId).toBe(999);
    expect(input.currentUserId).toBe(4321);
    expect(outcome).toMatchObject({
      source: 'getImagesFromSearch',
      error: true,
      resultIds: [],
    });
    expect(typeof outcome.elapsedMs).toBe('number');
  });
});
