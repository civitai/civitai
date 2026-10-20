import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  preventModelVersionLag,
  preventModelVersionLagBatch,
  preventReplicationLag,
  preventReplicationLagBatch,
} from '~/server/db/db-lag-helpers';
import { getModelWithDetailsCached } from '~/server/services/model-detail-cache.service';
import {
  bustModelDetailPublicCache,
  modelDetailPublicCacheKey,
} from '~/server/utils/model-detail-cache-key';

/**
 * The write-side hub for the shared model-row cache. Model and version writes mark the model in
 * the replication-lag helpers so the page reads its own writes; that mark is also what drops the
 * cached row. Lag tracking is off under test (`REPLICATION_LAG_DELAY` 0), which is the case the
 * bust must not depend on.
 */

const MODEL_A = 6101;
const MODEL_B = 6202;
const VERSION_ID = 6303;

let store: ReturnType<typeof installFakeCacheRedis>;
const seed = (...ids: number[]) =>
  ids.forEach((id) =>
    store.plant(modelDetailPublicCacheKey(id), { data: null, cachedAt: Date.now() }, 120)
  );
const cached = (id: number) => store.has(modelDetailPublicCacheKey(id));

beforeEach(() => {
  resetSharedMocks();
  store = installFakeCacheRedis();
});

describe('model writes drop the cached model row', () => {
  it.each([
    ['preventReplicationLag', () => preventReplicationLag('model', MODEL_A)],
    ['preventReplicationLagBatch', () => preventReplicationLagBatch('model', [MODEL_A])],
    ['preventModelVersionLag', () => preventModelVersionLag(MODEL_A, VERSION_ID)],
    ['preventModelVersionLagBatch', () => preventModelVersionLagBatch(MODEL_A, [])],
  ])('%s drops the entry for that model only', async (_, write) => {
    seed(MODEL_A, MODEL_B);
    await write();
    expect(cached(MODEL_A)).toBe(false);
    expect(cached(MODEL_B)).toBe(true);
  });

  it('accepts a string model id, as the lag helpers do', async () => {
    seed(MODEL_A);
    await preventReplicationLag('model', String(MODEL_A));
    expect(cached(MODEL_A)).toBe(false);
  });

  it('leaves the entry alone when the write is to another entity type with the same id', async () => {
    seed(MODEL_A);
    await preventReplicationLag('post', MODEL_A);
    await preventReplicationLagBatch('modelVersion', [MODEL_A]);
    expect(cached(MODEL_A)).toBe(true);
  });

  it('makes the next model read go to the database', async () => {
    dbMock.dbRead.model.findFirst.mockResolvedValue({
      id: MODEL_A,
      name: 'before',
      user: { id: 1 },
      modelVersions: [],
    } as never);
    await getModelWithDetailsCached({ id: MODEL_A });
    dbMock.dbRead.model.findFirst.mockResolvedValue({
      id: MODEL_A,
      name: 'after',
      user: { id: 1 },
      modelVersions: [],
    } as never);
    expect((await getModelWithDetailsCached({ id: MODEL_A }))?.name).toBe('before');

    await preventModelVersionLagBatch(MODEL_A, []);

    expect((await getModelWithDetailsCached({ id: MODEL_A }))?.name).toBe('after');
  });

  it('never fails the write when the cache is unreachable', async () => {
    redisMock.redis.del.mockRejectedValue(new Error('cache unavailable') as never);
    await expect(preventReplicationLag('model', MODEL_A)).resolves.toBeUndefined();
    await expect(bustModelDetailPublicCache([MODEL_A, MODEL_B])).resolves.toBeUndefined();
  });
});
