import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';

const getDbWithoutLag = vi.hoisted(() => vi.fn());
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { dbRead, dbWrite } from '~/server/db/client';
import { modelWithDetailsSelect } from '~/server/selectors/model.selector';
import {
  MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS,
  getModelWithDetailsCached,
} from '~/server/services/model-detail-cache.service';
import { modelDetailPublicCacheKey } from '~/server/utils/model-detail-cache-key';

/**
 * The shared model-row cache on its own: freshness, failure handling and the cases that skip it.
 * Rows are told apart by `name`, and every name below is distinct, so a test cannot pass by being
 * handed a neighbouring fixture.
 */

const MODEL_ID = 7301;
const OWNER_ID = 7302;

const row = (name: string) => ({
  id: MODEL_ID,
  name,
  user: { id: OWNER_ID },
  modelVersions: [{ id: 1, licensingFee: new Prisma.Decimal('3.25'), files: [] }],
});

const replicaRead = dbMock.dbRead.model.findFirst;
const primaryRead = dbMock.dbWrite.model.findFirst;

let store: ReturnType<typeof installFakeCacheRedis>;

beforeEach(() => {
  resetSharedMocks();
  vi.useRealTimers();
  store = installFakeCacheRedis();
  getDbWithoutLag.mockReset();
  getDbWithoutLag.mockResolvedValue(dbRead);
  replicaRead.mockResolvedValue(row('from-replica') as never);
  primaryRead.mockResolvedValue(row('from-primary') as never);
});

const nameOf = async (viewerId?: number) =>
  (await getModelWithDetailsCached({ id: MODEL_ID, viewerId }))?.name;

describe('getModelWithDetailsCached', () => {
  it('reads the replica once, then serves later reads from the cache', async () => {
    expect(await nameOf()).toBe('from-replica');
    replicaRead.mockResolvedValue(row('edited') as never);

    expect(await nameOf(99)).toBe('from-replica');
    expect(replicaRead).toHaveBeenCalledTimes(1);
    expect(replicaRead).toHaveBeenCalledWith({
      where: { id: MODEL_ID },
      select: modelWithDetailsSelect,
    });
  });

  it('serves the cached row for 60 seconds, then reads the database again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    expect(await nameOf()).toBe('from-replica');
    replicaRead.mockResolvedValue(row('after-ttl') as never);

    vi.setSystemTime(Date.now() + 59_900);
    expect(await nameOf()).toBe('from-replica');

    vi.setSystemTime(Date.now() + 200);
    expect(await nameOf()).toBe('after-ttl');
    expect(replicaRead).toHaveBeenCalledTimes(2);
  });

  it('returns the Decimal licensing fee as a Decimal after the round trip', async () => {
    await nameOf();
    const cached = await getModelWithDetailsCached({ id: MODEL_ID });
    expect(replicaRead).toHaveBeenCalledTimes(1);
    const fee = cached?.modelVersions[0].licensingFee;
    expect(fee).toBeInstanceOf(Prisma.Decimal);
    expect(Number(fee)).toBe(3.25);
  });

  it('caches a missing model as missing', async () => {
    replicaRead.mockResolvedValue(null as never);
    expect(await getModelWithDetailsCached({ id: MODEL_ID })).toBeNull();
    expect(await getModelWithDetailsCached({ id: MODEL_ID })).toBeNull();
    expect(replicaRead).toHaveBeenCalledTimes(1);
  });

  it('reads the primary and leaves the cache alone while the model is inside its lag window', async () => {
    await nameOf(); // a pre-write row is cached
    getDbWithoutLag.mockResolvedValue(dbWrite);

    expect(await nameOf()).toBe('from-primary');
    expect(getDbWithoutLag).toHaveBeenLastCalledWith('model', MODEL_ID);
    // The lag-window read neither replaced nor refreshed the entry.
    expect(redisMock.redis.packed.set).toHaveBeenCalledTimes(1);
    getDbWithoutLag.mockResolvedValue(dbRead);
    expect(await nameOf()).toBe('from-replica');
  });

  it('drops what it just cached when a write landed while it was reading', async () => {
    // The lag check passes before the read; the write's lag mark is there by the time it finishes.
    getDbWithoutLag.mockResolvedValueOnce(dbRead).mockResolvedValue(dbWrite);

    expect(await nameOf()).toBe('from-primary');
    expect(store.peek(modelDetailPublicCacheKey(MODEL_ID))).toBeNull();

    // Once the window has passed, the next read caches again.
    getDbWithoutLag.mockResolvedValue(dbRead);
    expect(await nameOf()).toBe('from-replica');
    expect(store.peek(modelDetailPublicCacheKey(MODEL_ID))).not.toBeNull();
  });

  it("gives the model's owner a fresh read instead of the cached row", async () => {
    await nameOf();
    replicaRead.mockResolvedValue(row('owner-fresh') as never);

    expect(await nameOf(OWNER_ID)).toBe('owner-fresh');
    expect(await nameOf(OWNER_ID + 1)).toBe('from-replica');
  });

  it('returns the database row when writing it to the cache fails', async () => {
    redisMock.redis.packed.set.mockRejectedValue(new Error('cache unavailable') as never);

    expect(await nameOf()).toBe('from-replica');
    expect(replicaRead).toHaveBeenCalledTimes(1);
  });

  it('falls back to the database when the cache read fails', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cache unavailable') as never);

    expect(await nameOf()).toBe('from-replica');
    expect(replicaRead).toHaveBeenCalledTimes(1);
  });

  it('reads the database once the deadline passes when the cache read stalls', async () => {
    vi.useFakeTimers();
    let releaseRead: (value: null) => void = () => undefined;
    redisMock.redis.packed.get.mockImplementation(
      (() => new Promise((resolve) => (releaseRead = resolve))) as never
    );

    let settled: unknown = 'pending';
    void nameOf().then((name) => (settled = name));

    await vi.advanceTimersByTimeAsync(MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS - 1);
    expect(settled).toBe('pending');
    expect(replicaRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('from-replica');
    expect(replicaRead).toHaveBeenCalledTimes(1);

    // The stalled read finally answers "miss": the abandoned cache call must not read again.
    releaseRead(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(replicaRead).toHaveBeenCalledTimes(1);
  });

  it('waits for its own slow database read at the deadline rather than starting a second one', async () => {
    vi.useFakeTimers();
    replicaRead.mockImplementation(
      (() =>
        new Promise((resolve) => setTimeout(() => resolve(row('slow-replica')), 2_000))) as never
    );

    let settled: unknown = 'pending';
    void nameOf().then((name) => (settled = name));

    await vi.advanceTimersByTimeAsync(MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS + 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe('slow-replica');
    expect(replicaRead).toHaveBeenCalledTimes(1);
  });

  // A deliberate constant pin: the stall test above times itself off the constant, so it cannot
  // notice the deadline growing back towards the Redis socket timeout it exists to undercut.
  it('pins the cache deadline at 500 ms or less', () => {
    expect(MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS).toBeGreaterThan(0);
    expect(MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS).toBeLessThanOrEqual(500);
  });

  it('propagates a database error unchanged', async () => {
    const dbError = new Error('replica unreachable');
    replicaRead.mockRejectedValue(dbError as never);

    await expect(getModelWithDetailsCached({ id: MODEL_ID })).rejects.toBe(dbError);
    expect(replicaRead).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });
});

/**
 * The cache codec keeps Dates and JSON but not `Prisma.Decimal` (or BigInt / Bytes), which the
 * service converts by hand for the one column it knows about. Walks the select against the schema
 * so a newly selected column of such a type fails here instead of reaching the page as NaN.
 */
describe('modelWithDetailsSelect columns the cache codec cannot carry', () => {
  type DmmfField = { name: string; kind: string; type: string };
  const models = new Map(
    Prisma.dmmf.datamodel.models.map((m) => [m.name, m.fields as unknown as DmmfField[]])
  );

  function nonCodecColumns(modelName: string, select: Record<string, unknown>): string[] {
    const fields = models.get(modelName) ?? [];
    return Object.entries(select).flatMap(([name, value]) => {
      const field = fields.find((f) => f.name === name);
      if (!field || !value) return [];
      if (field.kind === 'object') {
        const nested = (value as { select?: Record<string, unknown> }).select;
        // `relation: true` selects every scalar column of the related model.
        const all = Object.fromEntries(
          (models.get(field.type) ?? [])
            .filter((f) => f.kind !== 'object')
            .map((f) => [f.name, true])
        );
        return nonCodecColumns(field.type, nested ?? all);
      }
      return ['Decimal', 'BigInt', 'Bytes'].includes(field.type) ? [`${modelName}.${name}`] : [];
    });
  }

  it('is exactly the licensing fee the service converts', () => {
    expect(nonCodecColumns('Model', modelWithDetailsSelect)).toEqual(['ModelVersion.licensingFee']);
  });
});
