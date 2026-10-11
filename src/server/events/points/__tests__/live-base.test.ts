import { describe, expect, it, vi } from 'vitest';
import type { PointsReadRedis } from '~/server/events/points/read';
import type { RefereeRedis } from '~/server/events/points/referee';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { refereeTotals, resetLiveBase } = await import('~/server/events/points/referee');
const { getHatTotals, readTotals } = await import('~/server/events/points/read');
const { COUNT_BASE_MARK, eventSeasonKeys, LIVE_BUCKET_MS, liveBucket } = await import(
  '~/server/events/points/keys'
);

// String, hash and set semantics, with MULTI applied only at EXEC and RENAME failing on a missing
// source as Redis does. Every MULTI is recorded so a test can see what went in one transaction.
function fakeRedis() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  const transactions: string[][] = [];
  const hmGets: string[] = [];
  const remove = (key: string) =>
    Number(strings.delete(key)) + Number(hashes.delete(key)) + Number(sets.delete(key));
  const redis = {
    async get(key: string) {
      return strings.get(key) ?? null;
    },
    async hGetAll(key: string) {
      return { ...(hashes.get(key) ?? {}) };
    },
    async hmGet(key: string, fields: string[]) {
      hmGets.push(key);
      return fields.map((f) => hashes.get(key)?.[f] ?? null);
    },
    async hSet(key: string, values: Record<string, string>) {
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...values });
      return Object.keys(values).length;
    },
    async del(key: string) {
      return remove(key);
    },
    multi() {
      const ops: (() => void)[] = [];
      const log: string[] = [];
      const tx = {
        rename(from: string, to: string) {
          log.push(`rename ${from} ${to}`);
          ops.push(() => {
            const value = hashes.get(from);
            if (!value) throw new Error(`ERR no such key ${from}`);
            remove(to);
            hashes.set(to, value);
            hashes.delete(from);
          });
          return tx;
        },
        del(key: string) {
          log.push(`del ${key}`);
          ops.push(() => remove(key));
          return tx;
        },
        set(key: string, value: string) {
          log.push(`set ${key} ${value}`);
          ops.push(() => strings.set(key, value));
          return tx;
        },
        async exec() {
          transactions.push(log);
          ops.forEach((op) => op());
          return [];
        },
      };
      return tx;
    },
  };
  return { redis, strings, hashes, sets, transactions, hmGets };
}

const EVENT = { name: 'e', startDate: new Date('2026-11-01T00:00:00.000Z') };
const keys = eventSeasonKeys(EVENT.name, 'live');

const totals = (
  hat: Record<string, number>,
  team: Record<string, number> = {},
  owner: Record<string, number> = {},
  count: Record<string, number> = {}
) => ({
  hat: new Map(Object.entries(hat)),
  team: new Map(Object.entries(team)),
  owner: new Map(Object.entries(owner)),
  count: new Map(Object.entries(count)),
});

describe('resetLiveBase', () => {
  const OLD_CUT = 1000;
  const NEW_CUT = 1003;
  const cutAt = (bucket: number) => new Date(bucket * LIVE_BUCKET_MS);

  function seeded() {
    const fake = fakeRedis();
    fake.strings.set(keys.cut, String(OLD_CUT));
    fake.hashes.set(keys.base('hat'), { a: '10', b: '5', gone: '3' });
    fake.hashes.set(keys.base('team'), { Yellow: '18' });
    fake.hashes.set(keys.base('owner'), { '1': '18' });
    // Already settled by the previous run: must not be counted as shown again.
    fake.hashes.set(keys.live(OLD_CUT - 1, 'hat'), { a: '7', b: '7' });
    // Settled by this run.
    fake.hashes.set(keys.live(OLD_CUT, 'hat'), { a: '5' });
    fake.hashes.set(keys.live(NEW_CUT - 1, 'hat'), { c: '1' });
    // Still live after the new cut: readers keep adding it, so it is not part of this settlement.
    fake.hashes.set(keys.live(NEW_CUT, 'hat'), { a: '100', b: '100' });
    return fake;
  }

  it('reports only hats whose shown total moves, counting the buckets in [oldCut, newCut)', async () => {
    const fake = seeded();
    const changed = await resetLiveBase(
      fake.redis as unknown as RefereeRedis,
      EVENT,
      'live',
      cutAt(NEW_CUT),
      // a: 10 + 5 settled = 15, unchanged; b: corrected down; c: came from live only; gone: removed.
      totals({ a: 15, b: 4, c: 1 }, { Yellow: 20 }, { '1': 20 })
    );
    expect(changed.sort()).toEqual(['b', 'gone']);
  });

  it('replaces each base wholesale and moves the cut in the same MULTI', async () => {
    const fake = seeded();
    await resetLiveBase(
      fake.redis as unknown as RefereeRedis,
      EVENT,
      'live',
      cutAt(NEW_CUT),
      totals({ a: 15, b: 4, c: 1 }, { Yellow: 20 }, {}, { 'view:a': 3 })
    );
    expect(fake.hashes.get(keys.base('hat'))).toEqual({ a: '15', b: '4', c: '1' });
    expect(fake.hashes.get(keys.base('count'))).toEqual({ 'view:a': '3', settled: '1' });
    expect(fake.hashes.get(keys.base('team'))).toEqual({ Yellow: '20' });
    // No owner totals this run: the stale base is deleted, not left behind.
    expect(fake.hashes.has(keys.base('owner'))).toBe(false);
    expect(fake.strings.get(keys.cut)).toBe(String(NEW_CUT));
    expect(fake.transactions).toEqual([
      [
        `rename ${keys.base('hat')}:next ${keys.base('hat')}`,
        `rename ${keys.base('team')}:next ${keys.base('team')}`,
        `del ${keys.base('owner')}`,
        // The counts move with the points: a reader never pairs new counts with the old cut.
        `rename ${keys.base('count')}:next ${keys.base('count')}`,
        `set ${keys.cut} ${NEW_CUT}`,
      ],
    ]);
    // No staging key survives.
    expect([...fake.hashes.keys()].filter((k) => k.endsWith(':next'))).toEqual([]);
  });

  // A count base the referee wrote, even an empty one, says the live counts are complete.
  it('writes the count base with its mark even when no hat has a count', async () => {
    const fake = seeded();
    await resetLiveBase(
      fake.redis as unknown as RefereeRedis,
      EVENT,
      'live',
      cutAt(NEW_CUT),
      totals({ a: 15 })
    );
    expect(fake.hashes.get(keys.base('count'))).toEqual({ [COUNT_BASE_MARK]: '1' });
    expect(fake.transactions[0]).toContain(
      `rename ${keys.base('count')}:next ${keys.base('count')}`
    );
  });

  it('clears a leftover staging key before writing it, so a crashed run cannot leak fields', async () => {
    const fake = seeded();
    fake.hashes.set(`${keys.base('hat')}:next`, { leaked: '99' });
    await resetLiveBase(
      fake.redis as unknown as RefereeRedis,
      EVENT,
      'live',
      cutAt(NEW_CUT),
      totals({ a: 15 })
    );
    expect(fake.hashes.get(keys.base('hat'))).toEqual({ a: '15' });
  });

  // A bucket id with a fraction names no live key, so reads after the end would find no buckets.
  it('stores a whole bucket as the cut when the season ends inside a bucket, settling that bucket', async () => {
    const fake = seeded();
    const changed = await resetLiveBase(
      fake.redis as unknown as RefereeRedis,
      EVENT,
      'live',
      new Date((NEW_CUT - 1) * LIVE_BUCKET_MS + 60_000),
      totals({ a: 15, b: 5, c: 1 })
    );
    expect(fake.strings.get(keys.cut)).toBe(String(NEW_CUT));
    // c's bucket (NEW_CUT - 1) is settled into the base, so it is not a change.
    expect(changed).toEqual(['gone']);
  });

  it('on the first run (no cut yet) reports every hat with points', async () => {
    const fake = fakeRedis();
    const changed = await resetLiveBase(
      fake.redis as unknown as RefereeRedis,
      EVENT,
      'live',
      cutAt(NEW_CUT),
      totals({ a: 3, b: 4 })
    );
    expect(changed.sort()).toEqual(['a', 'b']);
  });

  it('accepts what refereeTotals produces', async () => {
    const fake = fakeRedis();
    const t = refereeTotals([
      {
        userId: 1,
        cosmeticId: 7,
        claimKey: 'claimed',
        team: 'Yellow',
        points: 6,
        views: 1,
        reactions: 1,
        comments: 0,
        stickers: 0,
        remixes: 0,
        modelLikes: 0,
      },
    ]);
    await resetLiveBase(fake.redis as unknown as RefereeRedis, EVENT, 'live', cutAt(NEW_CUT), t);
    expect(fake.hashes.get(keys.base('hat'))).toEqual({ '1:7:claimed': '6' });
    expect(fake.hashes.get(keys.base('owner'))).toEqual({ '1': '6' });
    expect(fake.hashes.get(keys.base('count'))).toEqual({
      'view:1:7:claimed': '1',
      'reaction:1:7:claimed': '1',
      settled: '1',
    });
  });
});

describe('getHatTotals', () => {
  const NOW = new Date('2026-11-05T12:07:00.000Z');
  const NOW_BUCKET = liveBucket(NOW);
  const HAT = { ownerId: 1, cosmeticId: 7, claimKey: 'cosmetic-purchase-v2-abc:def' };
  const field = '1:7:cosmetic-purchase-v2-abc:def';

  it('reads points and per-type counts per hat, named as the rows name them', async () => {
    const fake = fakeRedis();
    fake.strings.set(keys.cut, String(NOW_BUCKET - 1));
    fake.hashes.set(keys.base('hat'), { [field]: '30' });
    fake.hashes.set(keys.base('count'), {
      [COUNT_BASE_MARK]: '1',
      [`view:${field}`]: '20',
      [`remix:${field}`]: '40',
    });
    fake.hashes.set(keys.live(NOW_BUCKET, 'hat'), { [field]: '6' });
    fake.hashes.set(keys.live(NOW_BUCKET, 'count'), {
      [`view:${field}`]: '1',
      [`reaction:${field}`]: '3',
      [`comment:${field}`]: '5',
      [`sticker:${field}`]: '7',
    });
    const result = await getHatTotals(
      EVENT,
      [HAT, HAT],
      NOW,
      fake.redis as unknown as PointsReadRedis
    );
    expect(result).toEqual({
      points: { [field]: 36 },
      counts: {
        [field]: { impressions: 21, reactions: 3, comments: 5, stickers: 7, remixes: 40 },
      },
    });
  });

  // Before the referee has written a count base, the live buckets hold only what earned since the
  // deploy: no counts, so the reader falls back to the snapshot's, while the points stay live.
  it('reads no counts until a count base exists, and points all the same', async () => {
    const fake = fakeRedis();
    fake.strings.set(keys.cut, String(NOW_BUCKET - 1));
    fake.hashes.set(keys.base('hat'), { [field]: '30' });
    fake.hashes.set(keys.live(NOW_BUCKET, 'count'), { [`view:${field}`]: '1' });
    expect(await getHatTotals(EVENT, [HAT], NOW, fake.redis as unknown as PointsReadRedis)).toEqual(
      { points: { [field]: 30 }, counts: null }
    );
  });

  // The referee swaps both bases and moves the cut in one MULTI; a read that saw the old cut before
  // it and the new one after re-reads, so points and counts both come from the new base.
  it('re-reads both scopes when the cut moves mid-read', async () => {
    const fake = fakeRedis();
    const OLD = NOW_BUCKET - 2;
    const NEW = NOW_BUCKET - 1;
    fake.hashes.set(keys.base('hat'), { [field]: '15' });
    fake.hashes.set(keys.base('count'), { [COUNT_BASE_MARK]: '1', [`view:${field}`]: '9' });
    fake.hashes.set(keys.live(OLD, 'hat'), { [field]: '5' });
    fake.hashes.set(keys.live(OLD, 'count'), { [`view:${field}`]: '4' });
    fake.hashes.set(keys.live(NEW, 'hat'), { [field]: '1' });
    fake.hashes.set(keys.live(NEW, 'count'), { [`view:${field}`]: '2' });
    const cuts = [OLD, NEW, NEW, NEW];
    const redis = { ...fake.redis, get: vi.fn(async () => String(cuts.shift())) };
    const result = await getHatTotals(EVENT, [HAT], NOW, redis as unknown as PointsReadRedis);
    expect(result.points).toEqual({ [field]: 16 });
    expect(result.counts?.[field].impressions).toBe(11);
    expect(redis.get).toHaveBeenCalledTimes(4);
  });

  // One read of the cut each side for both scopes: the counts and the points always agree on it.
  // The counts' read cost: one HMGET per source key, the same keys as the points' in their own scope.
  it('reads the cut once on each side for points and counts together', async () => {
    const fake = fakeRedis();
    fake.strings.set(keys.cut, String(NOW_BUCKET - 2));
    const redis = { ...fake.redis, get: vi.fn(fake.redis.get) };
    await readTotals(EVENT, 'hat', ['x'], NOW, redis as unknown as PointsReadRedis);
    expect(fake.hmGets).toHaveLength(4);
    fake.hmGets.length = 0;
    redis.get.mockClear();
    await getHatTotals(EVENT, [HAT, HAT], NOW, redis as unknown as PointsReadRedis);
    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(fake.hmGets).toHaveLength(8);
    expect(fake.hmGets.filter((key) => key.endsWith(':count'))).toHaveLength(4);
  });
});

describe('readTotals', () => {
  const NOW = new Date('2026-11-05T12:07:00.000Z');
  const NOW_BUCKET = liveBucket(NOW);

  it('adds the live buckets from the cut to now on top of the base', async () => {
    const fake = fakeRedis();
    fake.strings.set(keys.cut, String(NOW_BUCKET - 1));
    fake.hashes.set(keys.base('hat'), { a: '10' });
    fake.hashes.set(keys.live(NOW_BUCKET - 2, 'hat'), { a: '1000' }); // settled into the base
    fake.hashes.set(keys.live(NOW_BUCKET - 1, 'hat'), { a: '2', b: '1' });
    fake.hashes.set(keys.live(NOW_BUCKET, 'hat'), { a: '3' });
    const result = await readTotals(
      EVENT,
      'hat',
      ['a', 'b', 'none'],
      NOW,
      fake.redis as unknown as PointsReadRedis
    );
    expect(result).toEqual({ a: 15, b: 1, none: 0 });
  });

  it('re-reads when the referee moves the cut mid-read, never pairing the new base with old buckets', async () => {
    const fake = fakeRedis();
    const OLD = NOW_BUCKET - 2;
    const NEW = NOW_BUCKET - 1;
    // The referee has already swapped in the new base (which includes bucket OLD) ...
    fake.hashes.set(keys.base('hat'), { a: '15' });
    fake.hashes.set(keys.live(OLD, 'hat'), { a: '5' });
    fake.hashes.set(keys.live(NEW, 'hat'), { a: '1' });
    // ... and the reader saw the old cut before the swap, the new one after.
    const cuts = [OLD, NEW, NEW, NEW];
    const redis = { ...fake.redis, get: vi.fn(async () => String(cuts.shift())) };
    const result = await readTotals(EVENT, 'hat', ['a'], NOW, redis as unknown as PointsReadRedis);
    expect(result).toEqual({ a: 16 });
    expect(redis.get).toHaveBeenCalledTimes(4);
  });

  it('retries only once, so a cut that keeps moving cannot stall a read', async () => {
    const fake = fakeRedis();
    let cut = NOW_BUCKET - 5;
    // Throws past 20 reads, so a retry loop that never stops fails here instead of hanging the run.
    const redis = {
      ...fake.redis,
      get: vi.fn(async () => {
        if (cut > NOW_BUCKET + 15) throw new Error('readTotals kept re-reading the cut');
        return String(cut++);
      }),
    };
    await readTotals(EVENT, 'hat', ['a'], NOW, redis as unknown as PointsReadRedis);
    expect(redis.get).toHaveBeenCalledTimes(4);
  });

  it('reads the count scope like any other', async () => {
    const fake = fakeRedis();
    fake.strings.set(keys.cut, String(NOW_BUCKET - 1));
    fake.hashes.set(keys.base('count'), { 'view:a': '4' });
    fake.hashes.set(keys.live(NOW_BUCKET, 'count'), { 'view:a': '2' });
    fake.hashes.set(keys.live(NOW_BUCKET, 'hat'), { 'view:a': '1000' });
    const result = await readTotals(
      EVENT,
      'count',
      ['view:a'],
      NOW,
      fake.redis as unknown as PointsReadRedis
    );
    expect(result).toEqual({ 'view:a': 6 });
  });

  it('reads nothing for no fields', async () => {
    const fake = fakeRedis();
    expect(
      await readTotals(EVENT, 'hat', [], NOW, fake.redis as unknown as PointsReadRedis)
    ).toEqual({});
    expect(fake.hmGets).toEqual([]);
  });
});
