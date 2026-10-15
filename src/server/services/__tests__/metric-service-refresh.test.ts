import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  IClickhouseClient,
  IRedisClient,
} from '../../../../event-engine-common/types/package-stubs';

// The event-engine logger is on at DEBUG under NODE_ENV=test and reads its level once, at import.
vi.hoisted(() => {
  process.env.EVENT_ENGINE_LOG_LEVEL = 'ERROR';
});

import { MetricService } from '../../../../event-engine-common/services/metrics';

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

function fakeRedis() {
  const hashes = new Map<string, Hash>();
  const strings = new Map<string, string>();
  const client = {
    hGetAll: vi.fn(async (key: string) => ({ ...(hashes.get(key) ?? {}) })),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (key: string) => Number(hashes.delete(key) || strings.delete(key))),
    // The only script MetricService runs is the stampede lock's SET NX.
    eval: vi.fn(
      async (
        script: string,
        { keys, arguments: args }: { keys: string[]; arguments: string[] }
      ) => {
        if (!script.includes("'NX'")) throw new Error(`unexpected script: ${script}`);
        if (strings.has(keys[0])) return 0;
        strings.set(keys[0], args[0]);
        return 1;
      }
    ),
    multi: () => {
      const ops: (() => void)[] = [];
      const multi = {
        del: (key: string) => (ops.push(() => hashes.delete(key)), multi),
        hSet: (key: string, fields: Hash) => (
          ops.push(() => hashes.set(key, { ...(hashes.get(key) ?? {}), ...fields })), multi
        ),
        expire: () => multi,
        exec: async () => ops.map((op) => op()),
      };
      return multi;
    },
  };
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
