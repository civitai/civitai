import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getBlocklistDTO` with the cluster cache unavailable. A blocklist is enforcement: when its cached
 * copy cannot be read it must never come back as an empty (allow-everything) list it did not read.
 *
 * - cache read rejects or is never answered → the row is read from the database, within the
 *   cache-read deadline rather than the client's 15s backstop;
 * - database also unavailable → the copy this process last read, if it has one;
 * - neither → it throws (fails closed), never `{ data: [] }`.
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { BlocklistType } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

// Fresh module per test: the last-known copy is process state.
async function load() {
  vi.resetModules();
  return import('~/server/services/blocklist.service');
}

const ROW = { id: 12, type: BlocklistType.LinkDomain, data: ['bad.example'] };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('getBlocklistDTO with the cache unavailable', () => {
  it('a rejecting cache read reads the row from the database', async () => {
    redisMock.redis.get.mockRejectedValue(new Error('cluster down'));
    dbMock.dbWrite.blocklist.findMany.mockResolvedValue([ROW]);
    const { getBlocklistDTO } = await load();

    const result = await within(getBlocklistDTO({ type: BlocklistType.LinkDomain }), 2000);

    expect(result).toEqual(ROW);
  });

  it('a cache read that never answers reads the row from the database within 750ms', async () => {
    redisMock.redis.get.mockImplementation(() => new Promise(() => undefined));
    dbMock.dbWrite.blocklist.findMany.mockResolvedValue([ROW]);
    const { getBlocklistDTO } = await load();

    const started = Date.now();
    const result = await within(getBlocklistDTO({ type: BlocklistType.LinkDomain }), 2000);

    expect(result).toEqual(ROW);
    expect(Date.now() - started).toBeLessThan(750);
  });

  it('cache and database both down: serves the copy this process last read, not an empty list', async () => {
    const { getBlocklistDTO } = await load();
    // A healthy read first, so the process has a copy.
    redisMock.redis.get.mockResolvedValue(JSON.stringify(ROW));
    expect(await getBlocklistDTO({ type: BlocklistType.LinkDomain })).toEqual(ROW);

    redisMock.redis.get.mockRejectedValue(new Error('cluster down'));
    dbMock.dbWrite.blocklist.findMany.mockRejectedValue(new Error('db down'));

    const result = await within(getBlocklistDTO({ type: BlocklistType.LinkDomain }), 2000);
    expect(result).toEqual(ROW);
  });

  it('cache down and the last copy is older than the cache TTL: re-reads the database', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const { getBlocklistDTO } = await load();
    redisMock.redis.get.mockResolvedValue(JSON.stringify(ROW));
    await getBlocklistDTO({ type: BlocklistType.LinkDomain });

    vi.setSystemTime(new Date('2026-11-01T00:06:00Z'));
    const updated = { ...ROW, data: ['bad.example', 'worse.example'] };
    redisMock.redis.get.mockRejectedValue(new Error('cluster down'));
    dbMock.dbWrite.blocklist.findMany.mockResolvedValue([updated]);

    expect(await getBlocklistDTO({ type: BlocklistType.LinkDomain })).toEqual(updated);
  });

  it('cache and database both down, last copy older than the cache TTL: still serves that copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const { getBlocklistDTO } = await load();
    redisMock.redis.get.mockResolvedValue(JSON.stringify(ROW));
    await getBlocklistDTO({ type: BlocklistType.LinkDomain });

    vi.setSystemTime(new Date('2026-11-01T02:00:00Z'));
    redisMock.redis.get.mockRejectedValue(new Error('cluster down'));
    dbMock.dbWrite.blocklist.findMany.mockRejectedValue(new Error('db down'));

    await expect(getBlocklistDTO({ type: BlocklistType.LinkDomain })).resolves.toEqual(ROW);
    expect(dbMock.dbWrite.blocklist.findMany).toHaveBeenCalled();
  });

  it('no copy anywhere: throws instead of answering with an empty list', async () => {
    redisMock.redis.get.mockRejectedValue(new Error('cluster down'));
    dbMock.dbWrite.blocklist.findMany.mockRejectedValue(new Error('db down'));
    const { getBlocklistDTO } = await load();

    await expect(getBlocklistDTO({ type: BlocklistType.LinkDomain })).rejects.toThrow();
  });
});
