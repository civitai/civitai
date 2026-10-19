import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * How long the card-badge cache holds a "this model has no sale" answer, and what clears it.
 *
 * `cache-helpers` and the cache builder behind it are real here; paid-access.model-sales.service.test.ts
 * replaces them to read the query, so it cannot see a lifetime or a bust. Redis is a Map that honours
 * the two options the builder leans on: `EX` (entries expire) and `NX` (never overwrite).
 */
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  getCapTier: vi.fn(async () => 'gold'),
}));

const { getActiveSalesForModels, bustModelSaleCache } = await import(
  '~/server/services/paid-access.service'
);

type SetOptions = { EX?: number; NX?: boolean };
const store = new Map<string, { value: unknown; expiresAt: number }>();
const live = (key: string) => {
  const entry = store.get(key);
  if (entry && entry.expiresAt <= Date.now()) store.delete(key);
  return store.get(key);
};
const writes: { key: string; value: Record<string, unknown>; options: SetOptions }[] = [];

const salesQuery = dbMock.dbRead.$queryRaw;

const MODEL = 7;
const VERSION = 70;
const START = new Date('2026-03-02T00:00:00.000Z');
const keyFor = (modelId: number) =>
  writes.find((write) => write.key.endsWith(`:${modelId}`))?.key ?? '';

const saleRow = {
  modelId: MODEL,
  saleId: 1,
  ownerId: 42,
  terms: { download: { price: 1000 } },
  startsAt: new Date('2026-03-01T00:00:00.000Z'),
  endsAt: new Date('2026-03-08T00:00:00.000Z'),
  discountType: 'Percent',
  discountAmount: 25,
};
const badge = {
  endsAt: new Date('2026-03-08T00:00:00.000Z'),
  discountType: 'Percent',
  discountAmount: 25,
};

const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);
const fetchBadges = () => getActiveSalesForModels([MODEL], new Date());

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  store.clear();
  writes.length = 0;

  redisMock.redis.packed.mGet.mockImplementation(async (keys: string[]) =>
    keys.map((key) => live(key)?.value ?? null)
  );
  redisMock.redis.packed.set.mockImplementation(
    async (key: string, value: Record<string, unknown>, options: SetOptions = {}) => {
      if (options.NX && live(key)) return null;
      writes.push({ key, value, options });
      store.set(key, { value, expiresAt: Date.now() + (options.EX ?? Infinity) * 1000 });
      return 'OK';
    }
  );

  salesQuery.mockResolvedValue([]);
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ modelId: MODEL }]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the model sale badge cache', () => {
  it('holds "no sale" for ten minutes and a sale for one', async () => {
    await fetchBadges();
    expect(writes).toHaveLength(1);
    expect(writes[0].value).toMatchObject({ modelId: MODEL, notFound: true });
    expect(writes[0].options).toEqual({ EX: 600, NX: true });

    store.clear();
    writes.length = 0;
    salesQuery.mockResolvedValue([saleRow]);

    await expect(fetchBadges()).resolves.toEqual({ [MODEL]: badge });
    expect(writes).toHaveLength(1);
    expect(writes[0].options).toEqual({ EX: 60 });
  });

  it('answers "no sale" from cache five minutes later, then re-queries once it lapses', async () => {
    await expect(fetchBadges()).resolves.toEqual({});
    expect(salesQuery).toHaveBeenCalledTimes(1);

    advance(5 * 60);
    await expect(fetchBadges()).resolves.toEqual({});
    expect(salesQuery).toHaveBeenCalledTimes(1);

    advance(5 * 60 + 1);
    await fetchBadges();
    expect(salesQuery).toHaveBeenCalledTimes(2);
  });

  it('shows a sale created while "no sale" is cached as soon as the model is busted', async () => {
    await fetchBadges();
    advance(5 * 60);
    salesQuery.mockResolvedValue([saleRow]);

    // Negative control: without the bust the cached answer still stands.
    await expect(fetchBadges()).resolves.toEqual({});
    expect(salesQuery).toHaveBeenCalledTimes(1);

    await bustModelSaleCache([VERSION]);

    // The bust replaced the marker rather than being refused by it.
    expect(store.get(keyFor(MODEL))?.value).toEqual({ modelId: MODEL, debounce: true });
    // The builder's default non-SWR bust window (the cache sets no debounceTime).
    expect(writes.at(-1)?.options).toEqual({ EX: 2 });

    await expect(fetchBadges()).resolves.toEqual({ [MODEL]: badge });
    expect(salesQuery).toHaveBeenCalledTimes(2);
  });

  it('does not pin "no sale" from a lookup that ran right after a bust', async () => {
    // A lookup that reads a lagging replica just after the write still sees no sale. Its marker must
    // not land, or the bust would have bought nothing.
    await bustModelSaleCache([VERSION]);
    await expect(fetchBadges()).resolves.toEqual({});
    expect(store.get(keyFor(MODEL))?.value).toEqual({ modelId: MODEL, debounce: true });

    salesQuery.mockResolvedValue([saleRow]);
    await expect(fetchBadges()).resolves.toEqual({ [MODEL]: badge });
    expect(salesQuery).toHaveBeenCalledTimes(2);
  });
});
