import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pack, unpack } from 'msgpackr';

// Backing store for the fake cache-cluster Redis. Values are stored as msgpackr-PACKED
// Buffers and unpacked on read — the SAME codec the real `redis.packed` client uses
// (set -> pack(value), get -> unpack(buffer)) — so the byte-identical claim is exercised
// through the real serializer end-to-end, not a pass-through fake. Cache hit/miss
// semantics stay real (a Map), letting us assert exactly when the origin DB query re-runs.
const {
  store,
  auctionFindMany,
  redisPackedGet,
  redisPackedSet,
  redisSetNxKeepTtlWithEx,
  redisDel,
} = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  auctionFindMany: vi.fn(),
  redisPackedGet: vi.fn(),
  redisPackedSet: vi.fn(),
  redisSetNxKeepTtlWithEx: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  // Call count on this mock is the cache-hit assertion.
  dbWrite: { auction: { findMany: auctionFindMany } },
  dbRead: {},
}));

// Cut the heavy sibling-service import graph (image.service pulls the event-engine-common
// submodule; notification/signal pull their own env graphs). None are exercised by
// getAllAuctions / getAllAuctionsUncached, so stubbing the used exports is safe and keeps
// the test a focused unit of the cache path.
vi.mock('~/server/services/image.service', () => ({ getImagesForModelVersionCache: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: vi.fn(), topicSend: vi.fn() } }));
// The fail-open logger pulls `safeError` from `~/server/logging/client`, which the global
// test setup mocks only partially. Stub it to a no-op — we assert the fail-open BEHAVIOUR
// (origin fetch still returns), not the log line.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

// Keep the real REDIS_KEYS (so the key we build matches the production constant) and only
// swap the live client for the in-memory fake. `fetchThroughCache` uses
// `redis.packed.{get,set}`, `redis.setNxKeepTtlWithEx` (stampede lock), and `redis.del`.
vi.mock('~/server/redis/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/redis/client')>();
  return {
    ...actual,
    redis: {
      packed: { get: redisPackedGet, set: redisPackedSet },
      setNxKeepTtlWithEx: redisSetNxKeepTtlWithEx,
      del: redisDel,
    },
  };
});

import { getAllAuctions, getAllAuctionsUncached } from '~/server/services/auction.service';
import { REDIS_KEYS } from '~/server/redis/client';

const KEY = REDIS_KEYS.CACHES.ACTIVE_AUCTIONS; // 'packed:caches:active-auctions'

// A representative active-auction row set exactly as `dbWrite.auction.findMany` returns
// it (only the fields `getAllAuctionsUncached` / `prepareBids` read). `auctionBase` is an
// opaque object passed straight through to the output — it must survive byte-identically
// through the cache. Returned FRESH per call so the in-place `.sort()` in the origin can't
// mutate a shared fixture across calls.
const makeAuctionRows = () => [
  {
    id: 1,
    minPrice: 100,
    quantity: 1,
    auctionBase: { id: 10, ecosystem: 'sd1', name: 'SD1' },
    bids: [
      { deleted: false, entityId: 5, amount: 150 },
      { deleted: false, entityId: 6, amount: 120 },
    ],
  },
  {
    id: 2,
    minPrice: 50,
    quantity: 2,
    auctionBase: { id: 20, ecosystem: 'sdxl', name: 'SDXL' },
    bids: [{ deleted: false, entityId: 7, amount: 30 }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  auctionFindMany.mockImplementation(async () => makeAuctionRows());

  // Real msgpackr round-trip: set packs the `{ data, cachedAt }` wrapper to a Buffer, get
  // unpacks it — mirrors the production `redis.packed` codec so serializer fidelity is
  // actually under test on the hit path.
  redisPackedGet.mockImplementation(async (key: string) => {
    const buf = store.get(key);
    return buf ? unpack(buf) : null;
  });
  redisPackedSet.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, pack(value));
  });
  // Single-threaded test: the stampede lock is always free.
  redisSetNxKeepTtlWithEx.mockResolvedValue(true);
  redisDel.mockImplementation(async (key: string) => {
    store.delete(key);
    return 1;
  });
});

describe('getAllAuctions — short-TTL read-through cache', () => {
  it('serves the second call from cache without re-hitting the PRIMARY DB', async () => {
    const first = await getAllAuctions();
    const second = await getAllAuctions();

    expect(auctionFindMany).toHaveBeenCalledTimes(1); // the win: one DB read, not two
    expect(first).toEqual(second);
    expect(redisPackedSet).toHaveBeenCalledTimes(1);
    // One global key serves every caller — the payload has no per-user/ctx variance.
    expect(redisPackedGet).toHaveBeenCalledWith(KEY, expect.anything());
  });

  it('returns output byte-identical to the uncached origin, through the real codec', async () => {
    const cached = await getAllAuctions();
    const uncached = await getAllAuctionsUncached();

    // Same array shape + values (id / auctionBase passthrough / computed lowestBidRequired).
    expect(cached).toEqual(uncached);
    expect(cached).toEqual([
      { id: 1, auctionBase: { id: 10, ecosystem: 'sd1', name: 'SD1' }, lowestBidRequired: 151 },
      { id: 2, auctionBase: { id: 20, ecosystem: 'sdxl', name: 'SDXL' }, lowestBidRequired: 50 },
    ]);

    // Prove byte-identity THROUGH the real msgpackr codec: unpack the actual stored Buffer
    // and assert every field survives the serializer (the `{data,cachedAt}` wrapper, the
    // passthrough auctionBase object, the computed integer lowestBidRequired).
    const buf = store.get(KEY);
    expect(Buffer.isBuffer(buf)).toBe(true);
    const wrapper = unpack(buf!) as { data: unknown; cachedAt: number };
    expect(wrapper.data).toEqual(cached);
    expect(typeof wrapper.cachedAt).toBe('number');
  });

  describe('TTL / staleness (30s)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('serves the stale cached value within the TTL even after the DB changes', async () => {
      const first = await getAllAuctions();
      expect(first[0].lowestBidRequired).toBe(151);

      // The DB now reflects a higher winning bid — but a cached read within 30s must NOT
      // see it (this is the display-only staleness the cache trades for the load cut).
      auctionFindMany.mockImplementation(async () => {
        const rows = makeAuctionRows();
        rows[0].bids.push({ deleted: false, entityId: 8, amount: 500 });
        return rows;
      });

      vi.advanceTimersByTime(29_000); // < 30s TTL
      const second = await getAllAuctions();

      expect(second).toEqual(first); // still the stale value
      expect(auctionFindMany).toHaveBeenCalledTimes(1); // DB not re-read
    });

    it('re-queries the DB once the TTL has elapsed', async () => {
      await getAllAuctions();

      auctionFindMany.mockImplementation(async () => {
        const rows = makeAuctionRows();
        rows[0].bids.push({ deleted: false, entityId: 8, amount: 500 });
        return rows;
      });

      vi.advanceTimersByTime(31_000); // > 30s TTL
      const afterExpiry = await getAllAuctions();

      expect(auctionFindMany).toHaveBeenCalledTimes(2); // origin re-read after expiry
      // entity8's 500 now wins -> lowestBidRequired = 501 (fresh value served).
      expect(afterExpiry[0].lowestBidRequired).toBe(501);
    });
  });

  it('fails OPEN to the origin on a Redis read error (no new failure mode)', async () => {
    redisPackedGet.mockRejectedValueOnce(new Error('redis down'));

    const result = await getAllAuctions();

    // Degrades to a slow-but-correct origin fetch rather than throwing.
    expect(auctionFindMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { id: 1, auctionBase: { id: 10, ecosystem: 'sd1', name: 'SD1' }, lowestBidRequired: 151 },
      { id: 2, auctionBase: { id: 20, ecosystem: 'sdxl', name: 'SDXL' }, lowestBidRequired: 50 },
    ]);
  });
});
