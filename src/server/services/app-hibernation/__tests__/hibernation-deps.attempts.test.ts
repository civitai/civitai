import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The production `AttemptStore` (`defaultHibernationDeps().attempts`) against the canonical redis
 * mock: an attempt is claimed and read back on the cache cluster client, and never touches system
 * Redis. The service tests run on an in-memory fake of this store, so nothing else runs it.
 */

vi.mock('~/server/services/app-hibernation/hibernation.repo', () => ({ hibernationRepo: {} }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppHibernateEnabled: vi.fn(async () => false),
}));

import { calledHybridNodes } from '~/__tests__/mocks/hybrid';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { AttemptRecord } from '~/server/services/app-hibernation/app-hibernation.service';
import { defaultHibernationDeps } from '~/server/services/app-hibernation/hibernation-deps';

const KEY_PREFIX = 'system:blocks:hibernation-attempt';

/** An in-memory string store behind `redis.set` (with NX) and `redis.get`. */
let store: Map<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  store = new Map();
  redisMock.redis.set.mockImplementation(
    async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }
  );
  redisMock.redis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
});

const first: AttemptRecord = {
  userId: 7,
  appKey: 'app-one',
  attemptId: 'att-123',
  reason: null,
  archiveKey: 'archives/7/app-one/one.tar',
};

describe('hibernation attempts on the cache cluster', () => {
  it('claim then get round-trips the record through the cluster client', async () => {
    const { attempts } = await defaultHibernationDeps();

    expect(await attempts.claim(first, 900)).toEqual(first);
    expect(redisMock.redis.set).toHaveBeenCalledWith(
      `${KEY_PREFIX}:att-123`,
      JSON.stringify(first),
      { NX: true, EX: 900 }
    );
    expect(await attempts.get('att-123')).toEqual(first);
    expect(await attempts.get('att-unknown')).toBeNull();

    expect(calledHybridNodes(['sysRedis'])).toEqual([]);
  });

  it('a second claim of the same attempt id answers the first record', async () => {
    const { attempts } = await defaultHibernationDeps();
    const second: AttemptRecord = { ...first, appKey: 'app-two', archiveKey: 'two.tar' };

    await attempts.claim(first, 900);
    expect(await attempts.claim(second, 900)).toEqual(first);
    expect(await attempts.get('att-123')).toEqual(first);

    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
    expect(calledHybridNodes(['sysRedis'])).toEqual([]);
  });
});
