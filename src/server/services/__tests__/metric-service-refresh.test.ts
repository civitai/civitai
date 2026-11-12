import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClickHouseError } from '@clickhouse/client';
import type {
  IClickhouseClient,
  IRedisClient,
} from '../../../../event-engine-common/types/package-stubs';

// The event-engine logger is on at DEBUG under NODE_ENV=test and reads its level once, at import.
vi.hoisted(() => {
  process.env.EVENT_ENGINE_LOG_LEVEL = 'ERROR';
});

import { MetricService } from '../../../../event-engine-common/services/metrics';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

// A `metrics:<type>:<id>` entry is a ClickHouse snapshot plus the watcher's live increments, and an
// increment that never lands is never re-applied. Hot entries slide their TTL, so before this an
// entry could stay wrong for as long as it stayed hot: image reaction counts sat days below the
// truth. These pin that an entry past its refresh age is still served, then rewritten from
// ClickHouse, so a lost increment lasts at most that long.

const HOUR = 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const metricKey = (id: number) => `metrics:Image:${id}`;
const lockKey = (id: number) => `metrics:lock:Image:${id}`;

type Hash = Record<string, string>;

// MetricService's scripts (the stampede lock, the stamped replace) run as real Lua.
function fakeRedis() {
  const strings = new Map<string, string>();
  const lua = createLuaRedis(Date.now(), { strings });
  const call = (command: string, key: string, ...args: string[]) =>
    lua.eval(`return redis.call('${command}', KEYS[1], unpack(ARGV))`, {
      keys: [key],
      arguments: args,
    });
  const client = {
    hGetAll: vi.fn(async (key: string) => ({ ...(lua.hash(key) ?? {}) })),
    expire: vi.fn(async () => 1),
    del: vi.fn((key: string) => call('DEL', key)),
    eval: lua.eval,
    // hReplaceEx's pipeline, used for a miss with no ClickHouse row.
    multi: () => {
      const ops: (() => Promise<unknown>)[] = [];
      const multi = {
        del: (key: string) => (ops.push(() => call('DEL', key)), multi),
        hSet: (key: string, fields: Hash) => (
          ops.push(() => call('HSET', key, ...Object.entries(fields).flat())), multi
        ),
        expire: () => multi,
        exec: async () => {
          const results = [];
          for (const op of ops) results.push(await op());
          return results;
        },
      };
      return multi;
    },
  };
  const hashes = { get: lua.hash, set: lua.setHash };
  return { client: client as unknown as IRedisClient, hashes, strings };
}

// Answers the populate query from `truth`, for the ids the query names.
function fakeClickhouse(truth: Record<number, Record<string, number>>) {
  const queriedIds: number[][] = [];
  const query = vi.fn(async ({ query }: { query: string }) => {
    const ids = (/entityId IN \(([^)]*)\)/.exec(query)?.[1] ?? '').split(',').map(Number);
    queriedIds.push(ids);
    const rows = ids.flatMap((id) =>
      Object.entries(truth[id] ?? {}).map(([metricType, value]) => ({
        entityId: id,
        metricType,
        value,
      }))
    );
    return { json: async () => rows };
  });
  return { client: { query } as unknown as IClickhouseClient, query, queriedIds };
}

describe('MetricService cache refresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Holds the unstamped-entry chance shut, so only age decides a refresh in these tests.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
  });

  it('serves an entry past its refresh age, then rewrites it from ClickHouse', async () => {
    const redis = fakeRedis();
    redis.hashes.set(metricKey(1), { Like: '5', _populatedAt: String(nowSeconds() - 2 * HOUR) });
    const ch = fakeClickhouse({ 1: { Like: 8 } });
    const service = new MetricService(ch.client, redis.client);

    const served = await service.fetch('Image', [1]);
    expect(served[1].Like).toBe(5);

    await vi.waitFor(() => expect(redis.hashes.get(metricKey(1))?.Like).toBe('8'));
    const stamp = Number(redis.hashes.get(metricKey(1))?._populatedAt);
    expect(nowSeconds() - stamp).toBeLessThan(60);
    expect((await service.fetch('Image', [1]))[1].Like).toBe(8);
  });

  it('leaves an entry inside its refresh age alone while refreshing an older one', async () => {
    const redis = fakeRedis();
    redis.hashes.set(metricKey(1), { Like: '5', _populatedAt: String(nowSeconds() - 2 * HOUR) });
    redis.hashes.set(metricKey(2), { Like: '3', _populatedAt: String(nowSeconds() - 10 * 60) });
    const ch = fakeClickhouse({ 1: { Like: 8 }, 2: { Like: 9 } });
    const service = new MetricService(ch.client, redis.client);

    await service.fetch('Image', [1, 2]);

    // The older entry being rewritten is what shows the background pass ran.
    await vi.waitFor(() => expect(redis.hashes.get(metricKey(1))?.Like).toBe('8'));
    expect(ch.queriedIds).toEqual([[1]]);
    expect(redis.hashes.get(metricKey(2))?.Like).toBe('3');
  });

  it('drops a metric the new snapshot no longer has', async () => {
    const redis = fakeRedis();
    redis.hashes.set(metricKey(1), {
      Like: '5',
      Cry: '1',
      _populatedAt: String(nowSeconds() - 2 * HOUR),
    });
    const ch = fakeClickhouse({ 1: { Like: 5 } });
    const service = new MetricService(ch.client, redis.client);

    await service.fetch('Image', [1]);

    await vi.waitFor(() =>
      expect(Number(redis.hashes.get(metricKey(1))?._populatedAt)).toBeGreaterThan(
        nowSeconds() - 60
      )
    );
    expect(redis.hashes.get(metricKey(1))).not.toHaveProperty('Cry');
    expect((await service.fetch('Image', [1]))[1].Cry).toBe(0);
  });

  it('stamps a populate on a miss and never returns the stamp as a metric', async () => {
    const redis = fakeRedis();
    const ch = fakeClickhouse({ 1: { Like: 4 } });
    const service = new MetricService(ch.client, redis.client);

    const populated = await service.fetch('Image', [1]);
    expect(populated[1]).not.toHaveProperty('_populatedAt');
    expect(Number(redis.hashes.get(metricKey(1))?._populatedAt)).toBeGreaterThan(nowSeconds() - 60);

    const cached = await service.fetch('Image', [1]);
    expect(cached[1].Like).toBe(4);
    expect(cached[1]).not.toHaveProperty('_populatedAt');
  });

  it('refreshes an entry written before the stamp existed only on its share of reads', async () => {
    const redis = fakeRedis();
    redis.hashes.set(metricKey(1), { Like: '5' });
    const ch = fakeClickhouse({ 1: { Like: 8 } });
    const service = new MetricService(ch.client, redis.client);

    await service.fetch('Image', [1]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ch.query).not.toHaveBeenCalled();

    vi.mocked(Math.random).mockReturnValue(0);
    await service.fetch('Image', [1]);
    await vi.waitFor(() => expect(redis.hashes.get(metricKey(1))?.Like).toBe('8'));
  });

  it('skips an entry another holder is already refreshing', async () => {
    const redis = fakeRedis();
    redis.hashes.set(metricKey(1), { Like: '5', _populatedAt: String(nowSeconds() - 2 * HOUR) });
    redis.hashes.set(metricKey(2), { Like: '6', _populatedAt: String(nowSeconds() - 2 * HOUR) });
    redis.strings.set(lockKey(2), '1');
    const ch = fakeClickhouse({ 1: { Like: 8 }, 2: { Like: 9 } });
    const service = new MetricService(ch.client, redis.client);

    await service.fetch('Image', [1, 2]);

    await vi.waitFor(() => expect(redis.hashes.get(metricKey(1))?.Like).toBe('8'));
    expect(ch.queriedIds).toEqual([[1]]);
  });

  it('keeps the lock after a failed refresh so the next read does not retry at once', async () => {
    const redis = fakeRedis();
    redis.hashes.set(metricKey(1), { Like: '5', _populatedAt: String(nowSeconds() - 2 * HOUR) });
    const query = vi.fn(async () => {
      throw new Error('clickhouse down');
    });
    const service = new MetricService({ query } as unknown as IClickhouseClient, redis.client);

    expect((await service.fetch('Image', [1]))[1].Like).toBe(5);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    // Let the failed pass finish its `finally` before reading the lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(redis.strings.has(lockKey(1))).toBe(true);

    expect((await service.fetch('Image', [1]))[1].Like).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(query).toHaveBeenCalledTimes(1);
  });
});

// The populate lookup names a few cache-missed ids, and it is most of the analytics DB's query CPU.
// It runs single-threaded (more threads only queue it behind other queries for CPU) under a server
// cap, because the app's budget for the read only stops the caller waiting. The query itself is
// not cancelled with the caller, so a lookup that is merely late still fills the cache.
describe('MetricService populate lookup settings', () => {
  const POINT_LOOKUP_SETTINGS = {
    max_threads: 1,
    max_execution_time: 6,
    timeout_overflow_mode: 'throw',
  };

  // What the client throws when the server stops a query at max_execution_time.
  const serverTimeout = () =>
    new ClickHouseError({
      message: 'Timeout exceeded: elapsed 6.0 seconds, maximum: 6',
      code: '159',
      type: 'TIMEOUT_EXCEEDED',
    });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a cold-miss lookup single-threaded under a server cap, and never cancels it', async () => {
    const redis = fakeRedis();
    const ch = fakeClickhouse({ 1: { Like: 4 }, 2: { Like: 7 } });
    const service = new MetricService(ch.client, redis.client);

    await service.fetch('Image', [1, 2]);

    expect(ch.query).toHaveBeenCalledTimes(1);
    const params = ch.query.mock.calls[0][0] as Record<string, unknown>;
    expect(params.clickhouse_settings).toEqual(POINT_LOOKUP_SETTINGS);
    expect(params).not.toHaveProperty('abort_signal');
  });

  it('runs the background refresh lookup with the same settings', async () => {
    const redis = fakeRedis();
    redis.hashes.set(metricKey(1), { Like: '5', _populatedAt: String(nowSeconds() - 2 * HOUR) });
    const ch = fakeClickhouse({ 1: { Like: 8 } });
    const service = new MetricService(ch.client, redis.client);

    await service.fetch('Image', [1]);

    await vi.waitFor(() => expect(ch.query).toHaveBeenCalledTimes(1));
    const params = ch.query.mock.calls[0][0] as Record<string, unknown>;
    expect(params.clickhouse_settings).toEqual(POINT_LOOKUP_SETTINGS);
  });

  it('applies the settings up to 100 ids and leaves a larger batch on the server defaults', async () => {
    const ids = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i);
    const redis = fakeRedis();
    const ch = fakeClickhouse({});
    const service = new MetricService(ch.client, redis.client);

    await service.fetch('Image', ids(100, 1));
    await service.fetch('Image', ids(101, 1001));

    expect(ch.queriedIds.map((batch) => batch.length)).toEqual([100, 101]);
    const [atLimit, overLimit] = ch.query.mock.calls.map(
      (call) => call[0] as Record<string, unknown>
    );
    expect(atLimit.clickhouse_settings).toEqual(POINT_LOOKUP_SETTINGS);
    expect(overLimit).not.toHaveProperty('clickhouse_settings');
  });

  it('after a server timeout, holds the lock so the next request waits instead of querying again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const redis = fakeRedis();
    const query = vi.fn(async () => {
      throw serverTimeout();
    });
    const service = new MetricService({ query } as unknown as IClickhouseClient, redis.client);

    // The caller sees the error; the app's image-metrics read catches it and serves the cache.
    await expect(service.fetch('Image', [1])).rejects.toBeInstanceOf(ClickHouseError);
    expect(redis.strings.has(lockKey(1))).toBe(true);
    // Re-armed to the full backstop TTL so it expires on its own: nothing heartbeats it any more.
    expect(redis.client.expire).toHaveBeenCalledWith(lockKey(1), 10);
    expect(redis.client.del).not.toHaveBeenCalledWith(lockKey(1));

    // The next request for the id waits out the lock, answers without throwing, and does not query.
    const next = service.fetch('Image', [1]);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(next).resolves.toHaveProperty('1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('still releases the lock when the lookup fails for any other reason', async () => {
    const redis = fakeRedis();
    const query = vi.fn(async () => {
      throw new Error('Socket hang up');
    });
    const service = new MetricService({ query } as unknown as IClickhouseClient, redis.client);

    await expect(service.fetch('Image', [1])).rejects.toThrow('Socket hang up');
    expect(redis.strings.has(lockKey(1))).toBe(false);
    expect(redis.client.expire).not.toHaveBeenCalledWith(lockKey(1), 10);
  });
});
