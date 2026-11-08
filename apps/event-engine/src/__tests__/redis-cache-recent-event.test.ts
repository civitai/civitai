// Outside `src/common` for the reason given at the top of signals.test.ts.
import { describe, expect, test } from 'vitest';
import { RedisCache } from '@/services/redis-cache';
import type { MetricExcludedUsers } from '@/services/metric-excluded-users';
import type { MetricEvent } from '@/types/events';
import { METRIC_RECENT_EVENT_TTL } from '@/common/utils/cache-keys';

// A tip sets the recent-event marker that makes event-engine-common's populate refresh
// early; other metrics don't, since every marked entity costs extra ClickHouse refreshes.
describe('RedisCache.incrementOnce recent-event marker', () => {
  function cacheRecordingMarkers() {
    const markers: { field: string; recentEventKey: string; recentEventTtl: number }[] = [];
    const client = {
      hIncrIfExistsOnce: async (
        _key: string,
        _dedupeKey: string,
        recentEventKey: string,
        field: string,
        _value: number,
        _ttl: number,
        recentEventTtl: number
      ) => {
        markers.push({ field, recentEventKey, recentEventTtl });
        return true;
      },
    };
    const excluded = { has: () => false } as unknown as MetricExcludedUsers;
    const cache = new RedisCache('redis://unused', excluded);
    // Bypass connect(): it would dial a real host.
    (cache as unknown as { client: unknown }).client = client;
    (cache as unknown as { isConnected: boolean }).isConnected = true;
    return { cache, markers };
  }

  const event = (metricType: string): MetricEvent => ({
    entityType: 'Image',
    entityId: 1001,
    metricType,
    metricValue: 1,
    userId: 7,
    timestamp: new Date('2030-01-01T00:00:00Z'),
  });

  test('a tip marks the entity and a reaction does not', async () => {
    const { cache, markers } = cacheRecordingMarkers();

    for (const metricType of ['tippedAmount', 'tippedCount', 'Like', 'Collection']) {
      await cache.incrementOnce(event(metricType));
    }

    expect(markers.map(({ field, recentEventTtl }) => [field, recentEventTtl])).toEqual([
      ['tippedAmount', METRIC_RECENT_EVENT_TTL],
      ['tippedCount', METRIC_RECENT_EVENT_TTL],
      ['Like', 0],
      ['Collection', 0],
    ]);
    expect(markers[0].recentEventKey).toBe('{metrics:Image:1001}:recent');
  });
});
