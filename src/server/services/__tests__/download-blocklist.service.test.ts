import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The download routes' ip/user blocklist rows, read through `fetchThroughCache`.
 *
 * Redis is modelled as a map so a write is visible to the next read. Every value below is
 * distinct from every other, so a test cannot pass by returning a neighbouring fixture.
 */

const logSysRedisFailOpen = vi.hoisted(() => vi.fn());
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen }));

import {
  DOWNLOAD_BLOCKLIST_CACHE_DEADLINE_MS,
  DOWNLOAD_BLOCKLIST_TTL,
  getDownloadBlocklistValue,
} from '~/server/services/download-blocklist.service';

const IP_KEY = 'packed:caches:download-blocklist:ip-blacklist';
const findUnique = dbMock.dbRead.keyValue.findUnique;

let store: Map<string, unknown>;

beforeEach(() => {
  resetSharedMocks();
  logSysRedisFailOpen.mockReset();
  vi.useRealTimers();
  store = new Map();
  redisMock.redis.packed.get.mockImplementation(
    (async (key: string) => store.get(key) ?? null) as never
  );
  redisMock.redis.packed.set.mockImplementation((async (key: string, value: unknown) => {
    store.set(key, value);
  }) as never);
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true as never);
  redisMock.redis.del.mockResolvedValue(0 as never);
});

describe('getDownloadBlocklistValue', () => {
  it('serves a fresh cached entry without touching the database', async () => {
    store.set(IP_KEY, { data: '192.0.2.10', cachedAt: Date.now() });

    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.10');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('on a miss reads the replica once and populates the cache for the next read', async () => {
    findUnique.mockResolvedValue({ key: 'ip-blacklist', value: '192.0.2.20' } as never);

    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.20');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { key: 'ip-blacklist' } });
    expect(store.get(IP_KEY)).toMatchObject({ data: '192.0.2.20' });

    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.20');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('keeps the two rows apart', async () => {
    findUnique.mockImplementation((async ({ where }: { where: { key: string } }) => ({
      key: where.key,
      value: where.key === 'user-blacklist' ? '4242' : '192.0.2.30',
    })) as never);

    await expect(getDownloadBlocklistValue('user-blacklist')).resolves.toBe('4242');
    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.30');
    expect(store.get('packed:caches:download-blocklist:user-blacklist')).toMatchObject({
      data: '4242',
    });
  });

  it('caches a missing row as null, so an absent list is not re-read every request', async () => {
    findUnique.mockResolvedValue(null as never);

    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBeNull();
    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('reflects an edit to the row once the entry is older than the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
    findUnique.mockResolvedValue({ key: 'ip-blacklist', value: '192.0.2.40' } as never);
    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.40');

    // The row is edited in the database.
    findUnique.mockResolvedValue({ key: 'ip-blacklist', value: '192.0.2.41' } as never);

    // Still inside the TTL: the cached value is served (this is the documented ceiling).
    vi.setSystemTime(Date.now() + (DOWNLOAD_BLOCKLIST_TTL - 5) * 1000);
    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.40');

    // Past it: the next read refreshes from the database and re-populates the cache.
    vi.setSystemTime(Date.now() + 10 * 1000);
    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.41');
    expect(store.get(IP_KEY)).toMatchObject({ data: '192.0.2.41' });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('pins the staleness ceiling at 60 seconds or less', () => {
    expect(DOWNLOAD_BLOCKLIST_TTL).toBeGreaterThan(0);
    expect(DOWNLOAD_BLOCKLIST_TTL).toBeLessThanOrEqual(60);
  });

  it('serves the previous value, without a database read, while another request refreshes an expired entry', async () => {
    store.set(IP_KEY, {
      data: '192.0.2.70',
      cachedAt: Date.now() - (DOWNLOAD_BLOCKLIST_TTL + 5) * 1000,
    });
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(false as never);
    findUnique.mockResolvedValue({ key: 'ip-blacklist', value: '192.0.2.71' } as never);

    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.70');
    expect(findUnique).not.toHaveBeenCalled();
  });

  // Integration check on `fetchThroughCache`'s own fail-open: a Redis read error never reaches
  // this module's catch. The catch is covered by the lock-contention case below.
  it('falls back to the database when the cache read fails', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cache unavailable') as never);
    findUnique.mockResolvedValue({ key: 'ip-blacklist', value: '192.0.2.50' } as never);

    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.50');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('falls back to the database, without waiting, when the cold key is being refilled elsewhere', async () => {
    redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(false as never);
    findUnique.mockResolvedValue({ key: 'ip-blacklist', value: '192.0.2.60' } as never);

    const started = Date.now();
    await expect(getDownloadBlocklistValue('ip-blacklist')).resolves.toBe('192.0.2.60');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('reads the database once the deadline passes when the cache read stalls', async () => {
    vi.useFakeTimers();
    // A read that never settles: what a stalled cache socket looks like to the caller.
    const neverSettles = new Promise<never>((resolve) => void resolve);
    redisMock.redis.packed.get.mockImplementation((() => neverSettles) as never);
    findUnique.mockResolvedValue({ key: 'ip-blacklist', value: '192.0.2.80' } as never);

    let settled: unknown = 'pending';
    void getDownloadBlocklistValue('ip-blacklist').then((value) => {
      settled = value;
    });

    await vi.advanceTimersByTimeAsync(DOWNLOAD_BLOCKLIST_CACHE_DEADLINE_MS - 1);
    expect(settled).toBe('pending');
    expect(findUnique).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('192.0.2.80');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  // The test above times itself off the constant, so it cannot notice the constant growing back
  // towards the Redis socket timeout this deadline exists to undercut.
  it('pins the cache deadline at 500 ms or less', () => {
    expect(DOWNLOAD_BLOCKLIST_CACHE_DEADLINE_MS).toBeGreaterThan(0);
    expect(DOWNLOAD_BLOCKLIST_CACHE_DEADLINE_MS).toBeLessThanOrEqual(500);
  });

  it('propagates a database error unchanged instead of resolving to an empty list', async () => {
    const dbError = new Error('replica unreachable');
    findUnique.mockRejectedValue(dbError as never);

    await expect(getDownloadBlocklistValue('ip-blacklist')).rejects.toBe(dbError);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
