import { beforeEach, describe, expect, it, vi } from 'vitest';

// The feeds index (`metrics_images_v1`) is retired: nothing writes to it, so its moderation fields
// (nsfwLevel, poi, minor, blockedFor, availability) are frozen. Every reader must answer without
// it. A reader that asks a feature flag first is not enough: a flag read that fails returns
// false, which is how next.civitai.com (no FEED_SERVICE_URL) would reach the stale index.
//
// `metricsSearchClient` is truthy here; a null client returns early before any query, which would
// make "no Meilisearch call" vacuous.

import type * as MeiliClient from '~/server/meilisearch/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as PromClient from '~/server/prom/client';

const {
  fetchDocumentsMock,
  imagesFeedCtor,
  populatedQueryMock,
  getFliptBooleanMock,
  retiredReadInc,
} = vi.hoisted(() => ({
  fetchDocumentsMock: vi.fn(),
  imagesFeedCtor: vi.fn(),
  populatedQueryMock: vi.fn(),
  getFliptBooleanMock: vi.fn(),
  retiredReadInc: vi.fn(),
}));

// Records the refusal counter; every other counter keeps its real implementation.
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return {
    ...actual,
    registerCounterWithLabels: ((config: { name: string }) =>
      config.name === 'search_index_retired_read_total'
        ? { inc: retiredReadInc }
        : actual.registerCounterWithLabels(
            config as Parameters<typeof actual.registerCounterWithLabels>[0]
          )) as typeof actual.registerCounterWithLabels,
  };
});

vi.mock('../../../../event-engine-common/feeds', () => ({
  ImagesFeed: class {
    constructor() {
      imagesFeedCtor();
    }
    populatedQuery = populatedQueryMock;
  },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { envValues } = vi.hoisted(() => ({
  envValues: { LOGGING: [] as string[] } as Record<string, unknown>,
}));
vi.mock('~/env/server', () => ({
  env: new Proxy(envValues, {
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

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  metricsSearchClient: {},
  fetchDocumentsAbortable: fetchDocumentsMock,
}));

// The flag check fails: getFliptBoolean answers false on any Flipt init/eval error.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: vi.fn().mockResolvedValue('off'),
  getFliptBoolean: getFliptBooleanMock,
}));

import {
  getAllImagesIndex,
  getImagesFromFeedSearch,
  getImagesFromSearch,
  getImagesFromSearchPostFilter,
  getImagesFromSearchPreFilter,
} from '../image.service';
import { isMeiliOff } from '../feed-primary.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.get.mockResolvedValue('[]');
redisMock.redis.set.mockResolvedValue(undefined);

const input = () =>
  ({
    currentUserId: 5,
    browsingLevel: 1,
    limit: 10,
    include: [],
    period: 'AllTime',
    sort: 'Newest',
  } as unknown as Parameters<typeof getImagesFromSearchPreFilter>[0]);

const refusals = (route: string) =>
  retiredReadInc.mock.calls.filter(
    ([labels]) => labels.index === 'metrics_images_v1' && labels.route === route
  ).length;

const noMeiliCall = () => {
  expect(fetchDocumentsMock).not.toHaveBeenCalled();
  expect(imagesFeedCtor).not.toHaveBeenCalled();
  expect(populatedQueryMock).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  envValues.FEED_SERVICE_URL = undefined;
  getFliptBooleanMock.mockResolvedValue(false);
  fetchDocumentsMock.mockResolvedValue({ results: [{ id: 1 }], total: 1 });
  populatedQueryMock.mockResolvedValue({ items: [], nextCursor: undefined });
});

describe('readers of the retired feeds index answer without it', () => {
  it('getImagesFromSearch (image.getInfinite without a feed service) returns an empty page', async () => {
    const result = await getImagesFromSearch(input());
    expect(result).toMatchObject({ data: [], nextCursor: undefined, source: 'meili' });
    noMeiliCall();
    expect(refusals('searchImages')).toBe(1);
  });

  it('getImagesFromSearchPreFilter returns an empty page', async () => {
    expect(await getImagesFromSearchPreFilter(input())).toEqual({
      data: [],
      nextCursor: undefined,
    });
    noMeiliCall();
    expect(refusals('preFilter')).toBe(1);
  });

  it('getImagesFromSearchPostFilter returns an empty page', async () => {
    expect(await getImagesFromSearchPostFilter(input())).toEqual({
      data: [],
      nextCursor: undefined,
    });
    noMeiliCall();
    expect(refusals('postFilter')).toBe(1);
  });

  it('getImagesFromFeedSearch (REST /api/v1/images fallback) returns an empty page', async () => {
    expect(await getImagesFromFeedSearch(input())).toEqual({ items: [], nextCursor: undefined });
    noMeiliCall();
    expect(refusals('feedSearch')).toBe(1);
  });

  it('getImagesFromSearch still returns empty when the flag read throws', async () => {
    getFliptBooleanMock.mockRejectedValue(new Error('flipt down'));
    const result = await getImagesFromSearch(input());
    expect(result).toMatchObject({ data: [] });
    noMeiliCall();
  });
});

describe('getAllImagesIndex without a feed service (next.civitai.com before talos-infra#2384, previews)', () => {
  it('answers an empty page named as the index path, without querying the index', async () => {
    const result = await getAllImagesIndex({
      limit: 5,
      period: 'AllTime',
      sort: 'Newest',
      browsingLevel: 1,
      include: [],
      headers: { src: 'test' },
    } as unknown as Parameters<typeof getAllImagesIndex>[0]);
    // `source` is what the preview smoke test branches on (tests/preview-image-feed.spec.ts).
    expect(result).toEqual({ items: [], nextCursor: undefined, source: 'meili' });
    noMeiliCall();
  });
});

describe('isMeiliOff with a feed service and the feeds index retired', () => {
  it('is true without reading the flag, so a failed flag read cannot reach the index', async () => {
    envValues.FEED_SERVICE_URL = 'http://feed.test';
    expect(await isMeiliOff({ currentUserId: 5 })).toBe(true);
    expect(getFliptBooleanMock).not.toHaveBeenCalled();
  });

  it('is false without a feed service; the readers above answer empty instead', async () => {
    expect(await isMeiliOff({ currentUserId: 5 })).toBe(false);
  });
});
