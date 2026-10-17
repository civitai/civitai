import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import type * as KeyGenerator from '~/server/utils/key-generator';

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => `hash-of-${key}`,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })) },
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');
const cacheModule = await import('~/server/auth/api-key-principal-cache');
const { evictCachedApiKeys, cacheApiKey } = cacheModule;

// Literal, not imported: an expectation derived from the constant moves with a mutated constant.
const ENTRY_TTL_S = 30;
const TOMBSTONE_TTL_S = 60;
const LAST_USED_S = 3600;

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-10-17T12:00:00.000Z');

type Row = {
  id: number;
  key: string;
  userId: number;
  tokenScope: number;
  lastUsedAt: Date | null;
  buzzLimit: { limit: number } | null;
  clientId: string | null;
  type: string;
  expiresAt: Date | null;
};

// Ids, owners, scopes and limits are pairwise distinct, so a result names the row it came from.
let rows: Row[];
const personal = (): Row => ({
  id: 31,
  key: 'hash-of-personal',
  userId: 301,
  tokenScope: 0b0110,
  lastUsedAt: new Date(T0.getTime() - 5 * 60 * 1000),
  buzzLimit: { limit: 777 },
  clientId: null,
  type: 'User',
  expiresAt: null,
});

/** The primary, as far as the bearer lookup can see it: key, allowlisted type, not expired. */
function findFirst({ where }: { where: { key: string; type: { in: string[] } } }) {
  const now = Date.now();
  const row = rows.find(
    (r) =>
      r.key === where.key &&
      where.type.in.includes(r.type) &&
      (r.expiresAt === null || r.expiresAt.getTime() >= now)
  );
  return Promise.resolve(row ? { ...row } : null);
}

const dbReads = () => dbMock.dbWrite.apiKey.findFirst.mock.calls.length;
const cacheKey = (hash: string) => `${REDIS_KEYS.CACHES.API_KEY_PRINCIPAL}:${hash}`;
let store: ReturnType<typeof installFakeCacheRedis>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  rows = [personal()];
  store = installFakeCacheRedis();
  dbMock.dbWrite.apiKey.findFirst.mockReset();
  dbMock.dbWrite.apiKey.findFirst.mockImplementation(findFirst as never);
  dbMock.dbWrite.apiKey.update.mockReset();
  dbMock.dbWrite.apiKey.update.mockResolvedValue({} as never);
  dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({ buzzLimit: { limit: 5 } } as never);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bearer lookup cache: hit, miss, TTL', () => {
  it('reads the primary once, then serves the same principal from the cache', async () => {
    const first = await getSessionFromBearerToken('personal');
    const second = await getSessionFromBearerToken('personal');
    expect(dbReads()).toBe(1);
    for (const s of [first, second]) {
      expect(s?.user.id).toBe(301);
      expect(s?.apiKeyId).toBe(31);
      expect(s?.tokenScope).toBe(0b0110);
      expect(s?.buzzLimit).toEqual({ limit: 777 });
      expect(s?.subject).toEqual({ type: 'apiKey', id: 31 });
    }
  });

  it('goes back to the primary once the entry is older than the TTL', async () => {
    await getSessionFromBearerToken('personal');
    vi.setSystemTime(T0.getTime() + (ENTRY_TTL_S - 1) * 1000);
    await getSessionFromBearerToken('personal');
    expect(dbReads()).toBe(1);
    vi.setSystemTime(T0.getTime() + (ENTRY_TTL_S + 1) * 1000);
    await getSessionFromBearerToken('personal');
    expect(dbReads()).toBe(2);
  });

  it('caches a system key too', async () => {
    rows = [{ ...personal(), id: 32, key: 'hash-of-system', type: 'System', userId: 302 }];
    await getSessionFromBearerToken('system');
    expect((await getSessionFromBearerToken('system'))?.apiKeyId).toBe(32);
    expect(dbReads()).toBe(1);
  });

  it('never caches a credential the primary does not know, so a just-created key works at once', async () => {
    rows = [];
    expect(await getSessionFromBearerToken('personal')).toBeNull();
    expect(store.has(cacheKey('hash-of-personal'))).toBe(false);
    rows = [personal()];
    expect((await getSessionFromBearerToken('personal'))?.apiKeyId).toBe(31);
  });

  // Each condition of the cacheable rule on its own: a client on a personal-type row, and an
  // access-type row with no client. Either alone must keep the row out of the cache.
  it.each([
    ['a User row that carries an OAuth client', { type: 'User', clientId: 'client-y' }],
    ['an Access row with no OAuth client', { type: 'Access', clientId: null }],
  ])('does not cache %s', async (_name, shape) => {
    rows = [{ ...personal(), id: 34, key: 'hash-of-odd', ...shape }];
    await getSessionFromBearerToken('odd');
    await getSessionFromBearerToken('odd');
    expect(dbReads()).toBe(2);
    expect(store.has(cacheKey('hash-of-odd'))).toBe(false);
  });

  it('does not cache an OAuth access token', async () => {
    rows = [{ ...personal(), id: 33, key: 'hash-of-oauth', type: 'Access', clientId: 'client-x' }];
    await getSessionFromBearerToken('oauth');
    await getSessionFromBearerToken('oauth');
    expect(dbReads()).toBe(2);
    expect(store.has(cacheKey('hash-of-oauth'))).toBe(false);
  });
});

describe('bearer lookup cache: constants', () => {
  it('pins the TTLs and the ordering the tombstone argument rests on', () => {
    expect(cacheModule.API_KEY_PRINCIPAL_TTL_SECONDS).toBe(30);
    expect(cacheModule.API_KEY_TOMBSTONE_TTL_SECONDS).toBe(60);
    expect(cacheModule.API_KEY_LAST_USED_DEBOUNCE_SECONDS).toBe(3600);
    expect(cacheModule.API_KEY_MAX_REFILL_AGE_SECONDS).toBe(10);
    expect(cacheModule.API_KEY_TOMBSTONE_TTL_SECONDS).toBeGreaterThanOrEqual(
      cacheModule.API_KEY_PRINCIPAL_TTL_SECONDS
    );
    expect(cacheModule.API_KEY_TOMBSTONE_TTL_SECONDS).toBeGreaterThan(
      cacheModule.API_KEY_MAX_REFILL_AGE_SECONDS
    );
  });
});

describe('bearer lookup cache: expiry', () => {
  it('rejects a cached key once its expiresAt has passed, though the entry is still in Redis', async () => {
    const expiresAt = new Date(T0.getTime() + 10_000);
    rows = [{ ...personal(), expiresAt }];
    expect((await getSessionFromBearerToken('personal'))?.apiKeyId).toBe(31);
    // Plant the entry with a long Redis TTL, so only the per-hit clock check can reject it.
    store.plant(cacheKey('hash-of-personal'), store.peek(cacheKey('hash-of-personal')), 3600);
    vi.setSystemTime(expiresAt.getTime() + 1);
    expect(await getSessionFromBearerToken('personal')).toBeNull();
  });

  it('does not cache a row whose expiry is already within the second', async () => {
    rows = [{ ...personal(), expiresAt: new Date(T0.getTime() + 400) }];
    expect((await getSessionFromBearerToken('personal'))?.apiKeyId).toBe(31);
    expect(store.has(cacheKey('hash-of-personal'))).toBe(false);
  });

  it('rejects an OAuth entry planted in the cache by another writer', async () => {
    rows = [];
    store.plant(
      cacheKey('hash-of-personal'),
      { apiKey: { ...personal(), type: 'Access', clientId: 'client-z' } },
      3600
    );
    expect(await getSessionFromBearerToken('personal')).toBeNull();
    expect(dbReads()).toBe(1);
  });

  it('never keeps an entry in Redis past the key’s own expiry', async () => {
    rows = [{ ...personal(), expiresAt: new Date(T0.getTime() + 7_000) }];
    await getSessionFromBearerToken('personal');
    expect(store.get(cacheKey('hash-of-personal'))?.expiresAt).toBe(T0.getTime() + 7_000);
  });
});

describe('bearer lookup cache: revocation', () => {
  it('stops accepting an evicted key on the very next request', async () => {
    await getSessionFromBearerToken('personal');
    rows = []; // the delete committed
    await evictCachedApiKeys(['hash-of-personal']);
    expect(await getSessionFromBearerToken('personal')).toBeNull();
    expect(store.get(cacheKey('hash-of-personal'))?.expiresAt).toBe(
      T0.getTime() + TOMBSTONE_TTL_S * 1000
    );
  });

  it('a refill whose primary read began before the revoke cannot overwrite the tombstone', async () => {
    let release!: () => void;
    dbMock.dbWrite.apiKey.findFirst.mockImplementationOnce((async (args: never) => {
      const row = await findFirst(args);
      await new Promise<void>((resolve) => (release = resolve));
      return row;
    }) as never);
    const inFlight = getSessionFromBearerToken('personal');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    rows = [];
    await evictCachedApiKeys(['hash-of-personal']);
    release();
    await inFlight;
    expect(await getSessionFromBearerToken('personal')).toBeNull();
  });

  it('a refill whose primary read stalls past the tombstone does not resurrect the key', async () => {
    let release!: () => void;
    dbMock.dbWrite.apiKey.findFirst.mockImplementationOnce((async (args: never) => {
      const row = await findFirst(args);
      await new Promise<void>((resolve) => (release = resolve));
      return row;
    }) as never);
    const inFlight = getSessionFromBearerToken('personal');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    rows = [];
    await evictCachedApiKeys(['hash-of-personal']);
    // The read stalls until the tombstone has expired, then returns the pre-revoke row.
    vi.setSystemTime(T0.getTime() + (TOMBSTONE_TTL_S + 1) * 1000);
    release();
    await inFlight;
    expect(store.peek(cacheKey('hash-of-personal'))).not.toHaveProperty('apiKey');
    expect(await getSessionFromBearerToken('personal')).toBeNull();
  });

  it('drops a refill older than the refill bound, and keeps one inside it', async () => {
    const row = { ...personal() } as never;
    const started = new Date(T0.getTime());
    vi.setSystemTime(T0.getTime() + 10_500);
    await cacheApiKey('hash-of-late', row, started);
    expect(store.has(cacheKey('hash-of-late'))).toBe(false);
    vi.setSystemTime(T0.getTime() + 9_500);
    await cacheApiKey('hash-of-ontime', row, started);
    expect(store.has(cacheKey('hash-of-ontime'))).toBe(true);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('cache cluster down'))],
    [
      'throws synchronously',
      () => {
        throw new Error('client not connected');
      },
    ],
  ])('eviction resolves when the tombstone write %s', async (_name, impl) => {
    redisMock.redis.packed.set.mockImplementation(impl as never);
    await expect(evictCachedApiKeys(['hash-a', 'hash-b'])).resolves.toBeUndefined();
    expect(redisMock.redis.packed.set).toHaveBeenCalledTimes(2);
  });

  it('keeps reading the primary while the tombstone stands, and caches nothing', async () => {
    await evictCachedApiKeys(['hash-of-personal']);
    await getSessionFromBearerToken('personal');
    await getSessionFromBearerToken('personal');
    expect(dbReads()).toBe(2);
  });
});

describe('bearer lookup cache: Redis unavailable', () => {
  it('falls back to the primary and still rejects a revoked key', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cache cluster down') as never);
    expect((await getSessionFromBearerToken('personal'))?.apiKeyId).toBe(31);
    rows = [];
    expect(await getSessionFromBearerToken('personal')).toBeNull();
    expect(dbReads()).toBe(2);
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
  });

  it('serves a cached key from the primary when only the refill write fails', async () => {
    redisMock.redis.packed.set.mockRejectedValue(new Error('write failed') as never);
    expect((await getSessionFromBearerToken('personal'))?.apiKeyId).toBe(31);
  });
});

describe('lastUsedAt throttle', () => {
  const writes = () => dbMock.dbWrite.apiKey.update.mock.calls.length;
  const stale = () => [{ ...personal(), lastUsedAt: new Date(T0.getTime() - 2 * HOUR) }];

  it('does not write while the stored value is under an hour old', async () => {
    await getSessionFromBearerToken('personal');
    expect(writes()).toBe(0);
  });

  it('writes once per hour per key even though the cached row still shows the old value', async () => {
    rows = stale();
    for (let i = 0; i < 4; i++) await getSessionFromBearerToken('personal');
    expect(writes()).toBe(1);
    expect(dbMock.dbWrite.apiKey.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: { lastUsedAt: T0 },
    });
    vi.setSystemTime(T0.getTime() + LAST_USED_S * 1000 + 1000);
    await getSessionFromBearerToken('personal');
    expect(writes()).toBe(2);
  });

  it('falls back to the stored value alone when Redis cannot take the claim', async () => {
    rows = stale();
    redisMock.redis.set.mockRejectedValue(new Error('cache cluster down') as never);
    await getSessionFromBearerToken('personal');
    expect(writes()).toBe(1);
  });

  it('releases the claim when the write fails, so the next request retries', async () => {
    rows = stale();
    dbMock.dbWrite.apiKey.update.mockRejectedValueOnce(new Error('primary blip') as never);
    await getSessionFromBearerToken('personal');
    await vi.waitFor(() =>
      expect(store.has(`${REDIS_KEYS.CACHES.API_KEY_LAST_USED}:31`)).toBe(false)
    );
    await getSessionFromBearerToken('personal');
    expect(writes()).toBe(2);
  });
});
