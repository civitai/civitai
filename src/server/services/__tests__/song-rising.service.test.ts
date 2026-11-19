import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: queryMock } }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';
import { getRisingSongIds } from '../song-rising.service';

const MUSIC_ON = { features: { music: true } };
const sqlOf = () => (queryMock.mock.calls[0][0] as TemplateStringsArray).join('?');

describe('getRisingSongIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.redis.packed.get.mockResolvedValue(null);
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
  });

  it('ranks songs by plays over today and the 6 days before, ties newest first, at most 100', async () => {
    queryMock.mockResolvedValue([
      { entityId: 30, plays: '9' },
      { entityId: 12, plays: '4' },
      { entityId: 11, plays: '4' },
    ]);

    expect(await getRisingSongIds(MUSIC_ON)).toEqual([30, 12, 11]);

    const sql = sqlOf().replace(/\s+/g, ' ');
    expect(sql).toContain('FROM entityMetricDailyAgg_v2_prev');
    expect(sql).toContain("entityType = 'Image' AND metricType = 'Play'");
    expect(sql).toContain('day >= today() - 6');
    expect(sql).toContain('sum(total)');
    expect(sql).toContain('ORDER BY plays DESC, entityId DESC');
    expect(sql).toContain('LIMIT 100');
  });

  it('serves a cached list without reading ClickHouse', async () => {
    redisMock.redis.packed.get.mockResolvedValue({ data: [5, 4], cachedAt: Date.now() });

    expect(await getRisingSongIds(MUSIC_ON)).toEqual([5, 4]);
    expect(queryMock).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.get).toHaveBeenCalledWith(
      'packed:caches:rising-songs',
      expect.anything()
    );
  });

  it('reads nothing with the music flag off', async () => {
    expect(await getRisingSongIds({ features: { music: false } })).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
  });
});
