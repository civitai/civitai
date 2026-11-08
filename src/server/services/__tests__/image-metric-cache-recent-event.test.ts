import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricService } from '../../../../event-engine-common/services/metrics';
import {
  cacheKeys,
  METRIC_RECENT_EVENT_TTL,
} from '../../../../event-engine-common/utils/cache-keys';
import type {
  IClickhouseClient,
  IRedisClient,
} from '../../../../event-engine-common/types/package-stubs';
import {
  cacheKeys as engineCacheKeys,
  METRIC_RECENT_EVENT_TTL as ENGINE_METRIC_RECENT_EVENT_TTL,
} from '../../../../apps/event-engine/src/common/utils/cache-keys';
import { withRedisHelpers as withEngineRedisHelpers } from '../../../../apps/event-engine/src/common/utils/query-utils';
import { MetricService as EngineMetricService } from '../../../../apps/event-engine/src/common/services/metrics';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

// The image metric cache has two writers on one Redis: the event-engine's per-event
// increment (apps/event-engine) and MetricService's populate from ClickHouse
// (event-engine-common). ClickHouse totals trail events by minutes. A tip that lands
// just before a populate is either skipped (cold key) or wiped by the populate's
// replace, and the snapshot doesn't have it yet. These run both writers' real Lua
// against one in-memory Redis.

const IMAGE_ID = 1001;
const HOUR = 60 * 60 * 1000;
const metricKey = cacheKeys.metric('Image', IMAGE_ID);

function setup() {
  const lua = createLuaRedis(Date.UTC(2030, 0, 1));
  vi.spyOn(Date, 'now').mockImplementation(() => lua.nowMs);

  const call = (command: string, key: string, ...args: string[]) =>
    lua.eval(`return redis.call('${command}', KEYS[1], unpack(ARGV))`, {
      keys: [key],
      arguments: args,
    });
  const redis = {
    eval: lua.eval,
    hGetAll: async (key: string) => lua.hash(key) ?? {},
    get: async (key: string) => lua.string(key) ?? null,
    expire: (key: string, seconds: number) => call('EXPIRE', key, String(seconds)),
    del: (key: string) => call('DEL', key),
    // hReplaceEx's pipeline (a miss, or a populate without the recent-event check).
    multi() {
      const queued: (() => Promise<unknown>)[] = [];
      const chain = {
        del: (key: string) => (queued.push(() => call('DEL', key)), chain),
        hSet: (key: string, fields: Record<string, string>) => (
          queued.push(() => call('HSET', key, ...Object.entries(fields).flat())), chain
        ),
        expire: (key: string, seconds: number) => (
          queued.push(() => call('EXPIRE', key, String(seconds))), chain
        ),
        exec: async () => {
          const results = [];
          for (const run of queued) results.push(await run());
          return results;
        },
      };
      return chain;
    },
  } as unknown as IRedisClient;

  // What ClickHouse's totals say right now; a test moves it as events "arrive" there.
  const chTotals: Record<string, number> = { Like: 5 };
  let chQueries = 0;
  const ch = {
    query: async () => {
      chQueries++;
      const rows = Object.entries(chTotals).map(([metricType, value]) => ({
        entityId: IMAGE_ID,
        metricType,
        value,
      }));
      return { json: async () => rows };
    },
  } as unknown as IClickhouseClient;

  const engineRedis = withEngineRedisHelpers(redis);
  let eventSeq = 0;
  // The event-engine passes the marker TTL for tips and 0 for every other metric
  // (RedisCache.incrementOnce, tested in apps/event-engine).
  const increment = (metricType: string, amount: number, recentEventTtl: number) =>
    engineRedis.hIncrIfExistsOnce(
      metricKey,
      `{${metricKey}}:dd:${metricType}:42:${++eventSeq}`,
      engineCacheKeys.metricRecentEvent('Image', IMAGE_ID),
      metricType,
      amount,
      3600,
      recentEventTtl
    );
  const tip = (amount: number) => increment('tippedAmount', amount, ENGINE_METRIC_RECENT_EVENT_TTL);
  const react = () => increment('Like', 1, 0);

  return {
    lua,
    chTotals,
    chQueries: () => chQueries,
    tip,
    react,
    service: new MetricService(ch, redis),
    // The event-engine's own (vendored) MetricService writes the same hashes.
    engineService: new EngineMetricService(ch, redis),
    advance: (ms: number) => {
      lua.nowMs += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('image metric cache: an event the ClickHouse snapshot has not caught up with', () => {
  it('a tip on an uncached image shows once ClickHouse has it, not an hour later', async () => {
    const { lua, chTotals, tip, service, advance } = setup();

    // Nothing has read the image, so the increment has no hash to land in.
    expect(await tip(30)).toBe(false);

    // 19s later the tipper's page reads it; ClickHouse doesn't have the tip yet.
    advance(19_000);
    expect((await service.fetch('Image', [IMAGE_ID]))[IMAGE_ID]).toMatchObject({
      Like: 5,
      tippedAmount: 0,
    });

    // ClickHouse catches up ~10 min later.
    chTotals.tippedAmount = 30;
    advance(METRIC_RECENT_EVENT_TTL * 1000 + 1000);
    await service.fetch('Image', [IMAGE_ID]);

    await vi.waitFor(() => expect(lua.hash(metricKey)?.tippedAmount).toBe('30'));
    expect(lua.errors).toEqual([]);
  });

  it('a tip wiped by a refresh that read ClickHouse before it is restored', async () => {
    const { lua, chTotals, tip, service, advance } = setup();

    await service.fetch('Image', [IMAGE_ID]);
    // An hour on, the entry is due a refresh and the image is tipped while it is hot.
    advance(HOUR);
    expect(await tip(30)).toBe(true);
    expect(lua.hash(metricKey)?.tippedAmount).toBe('30');

    // The next read refreshes from ClickHouse, which doesn't have the tip yet.
    await service.fetch('Image', [IMAGE_ID]);
    await vi.waitFor(() => expect(lua.hash(metricKey)?.tippedAmount).toBeUndefined());

    chTotals.tippedAmount = 30;
    advance(METRIC_RECENT_EVENT_TTL * 1000 + 1000);
    await service.fetch('Image', [IMAGE_ID]);

    await vi.waitFor(() => expect(lua.hash(metricKey)?.tippedAmount).toBe('30'));
    expect(lua.errors).toEqual([]);
  });

  it('a tip just before the event-engine populates the image is restored too', async () => {
    const { lua, chTotals, tip, service, engineService, advance } = setup();
    // An unstamped hash refreshes on a random share of reads; take that chance away.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    expect(await tip(30)).toBe(false);
    advance(19_000);
    await engineService.fetch('Image', [IMAGE_ID]);
    expect(lua.hash(metricKey)?.tippedAmount).toBeUndefined();

    chTotals.tippedAmount = 30;
    advance(METRIC_RECENT_EVENT_TTL * 1000 + 1000);
    await service.fetch('Image', [IMAGE_ID]);

    await vi.waitFor(() => expect(lua.hash(metricKey)?.tippedAmount).toBe('30'));
    // The event-engine's reader doesn't take the stamp for a metric.
    expect((await engineService.fetch('Image', [IMAGE_ID]))[IMAGE_ID]).not.toHaveProperty(
      '_populatedAt'
    );
    expect(lua.errors).toEqual([]);
  });

  it.each(['event-engine-common', 'event-engine'] as const)(
    "a new image's first tip survives a not-found populate by %s",
    async (writer) => {
      const { lua, chTotals, tip, service, engineService, advance } = setup();
      const populate = () =>
        writer === 'event-engine'
          ? engineService.fetch('Image', [IMAGE_ID])
          : service.fetch('Image', [IMAGE_ID]);
      // Every read slides the entry's TTL to 12h, and an unstamped entry never refreshes
      // by chance (sliding is 10% of reads, the unstamped refresh 5%).
      vi.spyOn(Math, 'random').mockReturnValue(0.07);
      delete chTotals.Like;

      expect(await tip(30)).toBe(false);
      advance(19_000);
      await populate();
      expect(lua.hash(metricKey)?.notFound).toBe('1');

      // A second tip lands on the not-found entry, and a read keeps it past its 5 min.
      expect(await tip(20)).toBe(true);
      expect((await service.fetch('Image', [IMAGE_ID]))[IMAGE_ID]?.tippedAmount).toBe(20);
      expect(lua.pttl(metricKey)).toBeGreaterThan(METRIC_RECENT_EVENT_TTL * 1000 + 1000);

      chTotals.tippedAmount = 50;
      advance(METRIC_RECENT_EVENT_TTL * 1000 + 1000);
      await service.fetch('Image', [IMAGE_ID]);

      await vi.waitFor(() => expect(lua.hash(metricKey)?.tippedAmount).toBe('50'));
      expect(lua.errors).toEqual([]);
    }
  );

  it('a reaction sets no marker, so its populate keeps the hour', async () => {
    const { lua, react, service, advance, chQueries } = setup();

    expect(await react()).toBe(false);
    // Real Redis rejects SET ... EX 0, which would abort the script before its HINCRBY.
    const markerKey = engineCacheKeys.metricRecentEvent('Image', IMAGE_ID);
    expect(lua.calls.filter(([command, key]) => command === 'SET' && key === markerKey)).toEqual(
      []
    );

    advance(19_000);
    await service.fetch('Image', [IMAGE_ID]);
    const populatedAt = Math.floor(lua.nowMs / 1000);
    advance(METRIC_RECENT_EVENT_TTL * 1000 + 1000);
    await service.fetch('Image', [IMAGE_ID]);

    expect(lua.hash(metricKey)?._populatedAt).toBe(String(populatedAt));
    expect(chQueries()).toBe(1);
    expect(lua.errors).toEqual([]);
  });

  it('an entry with no recent event is not refreshed early', async () => {
    const { lua, service, advance, chQueries } = setup();

    await service.fetch('Image', [IMAGE_ID]);
    advance(METRIC_RECENT_EVENT_TTL * 1000 + 1000);
    await service.fetch('Image', [IMAGE_ID]);

    // The populate's stamp is its own time, so the read above was not due a refresh.
    expect(lua.hash(metricKey)?._populatedAt).toBe(
      String(Math.floor((lua.nowMs - METRIC_RECENT_EVENT_TTL * 1000 - 1000) / 1000))
    );
    expect(chQueries()).toBe(1);
  });

  it('the event-engine and event-engine-common copies name the same marker', () => {
    // The event-engine vendors its own copy of cache-keys; if the two drift, the
    // marker is written where populate never looks.
    for (const [type, id] of [
      ['Image', IMAGE_ID],
      ['Post', 1],
    ] as const) {
      expect(engineCacheKeys.metricRecentEvent(type, id)).toBe(
        cacheKeys.metricRecentEvent(type, id)
      );
      expect(engineCacheKeys.metric(type, id)).toBe(cacheKeys.metric(type, id));
    }
    expect(ENGINE_METRIC_RECENT_EVENT_TTL).toBe(METRIC_RECENT_EVENT_TTL);
  });
});
