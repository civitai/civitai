import { describe, expect, it, vi } from 'vitest';
import type { PointsReadRedis } from '~/server/events/points/read';
import type { RefereeRedis } from '~/server/events/points/referee';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { refereeTotals, resetLiveBase } = await import('~/server/events/points/referee');
const { readTotals } = await import('~/server/events/points/read');
const { eventPointKeys, eventSeasonKeys, LIVE_BUCKET_MS, liveBucket } = await import(
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
    async sAdd(key: string, members: string[]) {
      const set = sets.get(key) ?? new Set();
      sets.set(key, set);
      members.forEach((m) => set.add(m));
      return members.length;
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
const changedKey = eventPointKeys(EVENT.name).changed;

const totals = (hat: Record<string, number>, team: Record<string, number> = {}, owner = {}) => ({
  hat: new Map(Object.entries(hat)),
  team: new Map(Object.entries(team)),
  owner: new Map(Object.entries(owner as Record<string, number>)),
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
    expect(changed).toBe(2);
    expect([...(fake.sets.get(changedKey) ?? [])].sort()).toEqual(['b', 'gone']);
  });

  it('replaces each base wholesale and moves the cut in the same MULTI', async () => {
    const fake = seeded();
    await resetLiveBase(
      fake.redis as unknown as RefereeRedis,
      EVENT,
      'live',
      cutAt(NEW_CUT),
      totals({ a: 15, b: 4, c: 1 }, { Yellow: 20 })
    );
    expect(fake.hashes.get(keys.base('hat'))).toEqual({ a: '15', b: '4', c: '1' });
    expect(fake.hashes.get(keys.base('team'))).toEqual({ Yellow: '20' });
    // No owner totals this run: the stale base is deleted, not left behind.
    expect(fake.hashes.has(keys.base('owner'))).toBe(false);
    expect(fake.strings.get(keys.cut)).toBe(String(NEW_CUT));
    expect(fake.transactions).toEqual([
      [
        `rename ${keys.base('hat')}:next ${keys.base('hat')}`,
        `rename ${keys.base('team')}:next ${keys.base('team')}`,
        `del ${keys.base('owner')}`,
        `set ${keys.cut} ${NEW_CUT}`,
      ],
    ]);
    // No staging key survives.
    expect([...fake.hashes.keys()].filter((k) => k.endsWith(':next'))).toEqual([]);
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

  it('on the first run (no cut yet) reports every hat with points', async () => {
    const fake = fakeRedis();
    const changed = await resetLiveBase(
      fake.redis as unknown as RefereeRedis,
      EVENT,
      'live',
      cutAt(NEW_CUT),
      totals({ a: 3, b: 4 })
    );
    expect(changed).toBe(2);
    expect([...(fake.sets.get(changedKey) ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('accepts what refereeTotals produces', async () => {
    const fake = fakeRedis();
    const t = refereeTotals([
      { userId: 1, cosmeticId: 7, claimKey: 'claimed', team: 'Yellow', points: 6 },
    ]);
    await resetLiveBase(fake.redis as unknown as RefereeRedis, EVENT, 'live', cutAt(NEW_CUT), t);
    expect(fake.hashes.get(keys.base('hat'))).toEqual({ '1:7:claimed': '6' });
    expect(fake.hashes.get(keys.base('owner'))).toEqual({ '1': '6' });
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
    const result = await readTotals(
      EVENT,
      'hat',
      ['a'],
      NOW,
      redis as unknown as PointsReadRedis
    );
    expect(result).toEqual({ a: 16 });
    expect(redis.get).toHaveBeenCalledTimes(4);
  });

  it('retries only once, so a cut that keeps moving cannot stall a read', async () => {
    const fake = fakeRedis();
    let cut = NOW_BUCKET - 5;
    const redis = { ...fake.redis, get: vi.fn(async () => String(cut++)) };
    await readTotals(EVENT, 'hat', ['a'], NOW, redis as unknown as PointsReadRedis);
    expect(redis.get).toHaveBeenCalledTimes(4);
  });

  it('reads nothing for no fields', async () => {
    const fake = fakeRedis();
    expect(
      await readTotals(EVENT, 'hat', [], NOW, fake.redis as unknown as PointsReadRedis)
    ).toEqual({});
    expect(fake.hmGets).toEqual([]);
  });
});
