import { beforeEach, describe, expect, it, vi } from 'vitest';

// `source` is what the BitDex feed notice keys on: it must name the backend that
// ACTUALLY served the page, not the flag variant. Two ways that diverges:
//   - shadow runs BitDex in the background and serves Meili → must report meili
//   - primary falls through to Meili when BitDex errors → must report meili
// Getting either wrong puts a "we're testing a new system" notice over old-system
// results, so the feedback would describe the wrong backend.
//
// Same minimal-seam mocking as image-feed-clickhouse-failsoft.test.ts: stub the
// event-engine-common submodule + infra clients + env so importing image.service
// doesn't boot real infra.

import type * as BitdexClient from '~/server/bitdex/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as MeiliClient from '~/server/meilisearch/client';

const { queryBitdexMock, getFliptVariantMock } = vi.hoisted(() => ({
  queryBitdexMock: vi.fn(),
  getFliptVariantMock: vi.fn(),
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(async () => undefined),
  safeError: (e: unknown) => e,
}));

vi.mock('../../../../event-engine-common/feeds', () => ({
  ImagesFeed: class {
    populatedQuery = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

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
vi.mock('~/server/redis/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- self-referential key proxy
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

// `metricsSearchClient: null` makes getImagesFromSearchPreFilter return an empty
// page immediately — the Meili leg still RUNS and still stamps source 'meili',
// which is the whole point, without needing a live index.
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  metricsSearchClient: null,
}));

vi.mock('~/server/bitdex/client', async (importOriginal) => ({
  ...(await importOriginal<typeof BitdexClient>()),
  queryBitdex: queryBitdexMock,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: getFliptVariantMock,
  getFliptBoolean: vi.fn().mockResolvedValue(false),
}));

import { getImagesFromSearch } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const bitdexDoc = {
  id: 101,
  url: 'abc',
  hash: null,
  nsfwLevel: 1,
  userId: 7,
  type: 'image',
  availability: 'Public',
  postId: 55,
  postedToId: null,
  hasMeta: true,
  onSite: true,
  poi: false,
  minor: false,
  width: 100,
  height: 100,
  reactionCount: 0,
  commentCount: 0,
  collectedCount: 0,
  sortAt: 1_700_000_000,
  publishedAt: 1_700_000_000,
};

// `cursor: undefined` terminates fetchBitdexPrimary's pass loop on the first
// iteration. A fake that always returned a cursor would spin to MAX_PASSES.
const bitdexPage = { documents: [bitdexDoc], cursor: undefined };

const baseInput = {
  limit: 10,
  browsingLevel: 1,
  periodMode: 'published',
  include: [],
  currentUserId: undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ImageSearchInput isn't exported
} as any;

describe('getImagesFromSearch — reported source names the backend that served the page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryBitdexMock.mockResolvedValue(bitdexPage);
  });

  it('reports meili in SHADOW mode even though BitDex ran and returned documents', async () => {
    getFliptVariantMock.mockResolvedValue('shadow');

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('meili');
  });

  it('reports bitdex in PRIMARY mode when BitDex serves the page', async () => {
    getFliptVariantMock.mockResolvedValue('primary');

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('bitdex');
  });

  it('reports meili in PRIMARY mode when BitDex throws and Meili serves the fallback', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    queryBitdexMock.mockRejectedValue(new Error('bitdex is down'));

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('meili');
  });
});
