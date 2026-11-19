import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = fetchMock;
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/env/server', () => ({
  env: new Proxy(
    { CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: 50, LOGGING: [] as string[] } as Record<string, unknown>,
    {
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
    }
  ),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';
import { getSongPlayCounts } from '../image.service';

const MUSIC_ON = { features: { music: true } };

describe('getSongPlayCounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads a song's Play from the metric reader, and 0 when it has none", async () => {
    fetchMock.mockResolvedValue({ 1: { Play: 7, Like: 2 }, 2: { Like: 3 } });

    const plays = await getSongPlayCounts({ ids: [1, 2, 3], ...MUSIC_ON });

    expect(fetchMock).toHaveBeenCalledWith('Image', [1, 2, 3]);
    expect(plays).toEqual({ 1: 7, 2: 0, 3: 0 });
  });

  it('reads Play from the cached hash when ClickHouse cannot answer', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    redisMock.redis.hGetAll.mockImplementation(async (key: string) =>
      key.endsWith(':1') ? { Play: '12', Like: '1' } : {}
    );

    const plays = await getSongPlayCounts({ ids: [1, 2], ...MUSIC_ON });

    // An id the cache cannot answer is unknown: left out, so the card shows no count.
    expect(plays).toEqual({ 1: 12 });
  });

  it('reads nothing with the music flag off', async () => {
    const plays = await getSongPlayCounts({ ids: [1], features: { music: false } });

    expect(plays).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
