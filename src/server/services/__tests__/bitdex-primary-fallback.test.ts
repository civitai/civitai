import { beforeEach, describe, expect, it, vi } from 'vitest';

// A BitDex query that FAILS and one that legitimately matches nothing both reach
// fetchBitdexPrimary as an empty accumulation. When the own-excluded second pass is
// running (logged-in caller, no userId filter, first page) that empty accumulation slips
// past the `!accumulated.length && !ownExcludedPromise` guard, so getImagesFromSearch
// receives a truthy `{ data: [] }`, never consults Meilisearch, and the user gets a blank
// feed instead of a degraded one.
//
// Pinned here, end to end through getImagesFromSearch:
//   - main pass FAILED, nothing accumulated → falls through to Meili (source 'meili')
//   - main pass returned a legitimate empty 200 → serves the empty BitDex page
//
// Minimal-seam mocking follows image-feed-clickhouse-failsoft.test.ts: stub the infra
// clients and env so importing image.service doesn't boot anything real.

const { queryBitdexOutcomeMock, queryBitdexMock } = vi.hoisted(() => ({
  queryBitdexOutcomeMock: vi.fn(),
  queryBitdexMock: vi.fn(),
}));

vi.mock('~/server/bitdex/client', () => ({
  queryBitdex: queryBitdexMock,
  queryBitdexOutcome: queryBitdexOutcomeMock,
  fetchBitdexDocuments: vi.fn(),
}));

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

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {
      get: vi.fn().mockResolvedValue('[]'),
      set: vi.fn().mockResolvedValue(undefined),
      packed: { get: vi.fn(), set: vi.fn() },
    },
    sysRedis: {},
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
  };
});

// NB: do NOT mock '~/server/flipt/client' — a catch-all Proxy mock wedges image.service's
// module-load import. The real module loads fine and getFliptBoolean fail-opens to false.

import { getImagesFromSearch } from '../image.service';

// currentUserId with no userId filter and no cursor is exactly the shape that starts the
// own-excluded second pass — the condition under which the blank feed reproduced.
const baseInput = {
  limit: 10,
  browsingLevel: 1,
  currentUserId: 500,
  bitdexMode: 'primary',
} as any;

const emptyOk = {
  status: 'ok' as const,
  result: { ids: [], total_matched: 0, documents: [], elapsed_us: 1 },
};

describe('BitDex primary fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Meilisearch is unconfigured here, so the fall-through path returns an empty page
    // tagged `source: 'meili'` — enough to observe WHICH backend answered.
    queryBitdexMock.mockResolvedValue(null);
  });

  it('falls through to Meili when the main BitDex query fails', async () => {
    queryBitdexOutcomeMock.mockResolvedValue({ status: 'failed' });

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('meili');
  });

  it('serves the empty BitDex page when the main query legitimately matches nothing', async () => {
    queryBitdexOutcomeMock.mockResolvedValue(emptyOk);

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('bitdex');
    expect(result.data).toEqual([]);
  });

  it('still serves BitDex results when a later pagination pass fails', async () => {
    queryBitdexOutcomeMock.mockResolvedValueOnce({
      status: 'ok',
      result: {
        ids: [1],
        total_matched: 1,
        cursor: { sortAt: 1 },
        elapsed_us: 1,
        documents: [
          {
            id: 1,
            url: 'a.jpeg',
            nsfwLevel: 1,
            userId: 7,
            sortAt: 1_700_000_000,
            publishedAt: 1_700_000_000,
          },
        ],
      },
    });
    queryBitdexOutcomeMock.mockResolvedValue({ status: 'failed' });

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('bitdex');
    expect(result.data.map((d: { id: number }) => d.id)).toEqual([1]);
  });
});
