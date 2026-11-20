import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import { addToQueue, checkoutQueue, mergeQueue } from '~/server/redis/queues';

// A stateful in-memory sysRedis: the race is an interleaving of a consumer's checkout and the
// hourly merge, which per-command mocks cannot reproduce.
const { redis, fail } = (() => {
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const fail = new Set<string>();
  const guard = (command: string) => {
    if (fail.has(command)) throw new Error(`${command} down`);
  };
  const deleteKey = (key: string) =>
    [hashes, sets, strings, zsets].reduce((n, store) => n + (store.delete(key) ? 1 : 0), 0);
  const redis = {
    reset() {
      [hashes, sets, strings, zsets].forEach((store) => store.clear());
      fail.clear();
    },
    async hGet(key: string, field: string) {
      guard('hGet');
      return hashes.get(key)?.get(field) ?? null;
    },
    async hGetAll(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hSet(key: string, field: string, value: string) {
      guard('hSet');
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)!.set(field, value);
      return 1;
    },
    async sAdd(key: string, members: string[]) {
      if (!sets.has(key)) sets.set(key, new Set());
      members.forEach((m) => sets.get(key)!.add(m));
      return members.length;
    },
    async sMembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
    async del(keys: string | string[]) {
      return (Array.isArray(keys) ? keys : [keys]).reduce((n, key) => n + deleteKey(key), 0);
    },
    async exists(key: string) {
      return strings.has(key) ? 1 : 0;
    },
    /** Whether a sorted set is stored under the key; Redis drops one with its last member. */
    hasZset: (key: string) => zsets.has(key),
    async set(key: string, value: string) {
      strings.set(key, value);
      return 'OK';
    },
    async zAdd(key: string, { score, value }: { score: number; value: string }) {
      guard('zAdd');
      if (!zsets.has(key)) zsets.set(key, new Map());
      zsets.get(key)!.set(value, score);
      return 1;
    },
    async zRem(key: string, member: string) {
      guard('zRem');
      const zset = zsets.get(key);
      const removed = zset?.delete(member) ? 1 : 0;
      if (zset && !zset.size) zsets.delete(key);
      return removed;
    },
    async zRemRangeByScore(key: string, min: number | string, max: number | string) {
      guard('zRemRangeByScore');
      const zset = zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const [member, score] of zset)
        if ((min === '-inf' || score >= Number(min)) && score <= Number(max)) {
          zset.delete(member);
          removed++;
        }
      if (!zset.size) zsets.delete(key);
      return removed;
    },
    async zCount(key: string, min: number | string, max: number | string) {
      guard('zCount');
      const zset = zsets.get(key);
      if (!zset) return 0;
      return [...zset.values()].filter(
        (score) => score >= Number(min) && (max === '+inf' || score <= Number(max))
      ).length;
    },
  };
  return { redis, fail };
})();

// The fake answers the canonical sysRedis mock's commands, so queues.ts runs against it unchanged.
const COMMANDS = [
  'hGet',
  'hGetAll',
  'hSet',
  'sAdd',
  'sMembers',
  'del',
  'exists',
  'set',
  'zAdd',
  'zRem',
  'zRemRangeByScore',
  'zCount',
] as const;

const KEY = 'models_v9:Update';
const LEASE = `${REDIS_SYS_KEYS.QUEUES.BUCKETS}:${KEY}:${REDIS_SUB_KEYS.QUEUES.CONSUMING}`;
// Bucket names carry Date.now(), so each step gets its own millisecond.
let clock = Date.UTC(2026, 10, 15, 18);
const tick = (ms = 1) => vi.setSystemTime((clock += ms));

/** Every id still queued, with repeats: what the next consumer would process. */
async function queued() {
  tick();
  const queue = await checkoutQueue(KEY, false, true);
  return queue.content.sort((a, b) => a - b);
}

beforeEach(() => {
  redis.reset();
  for (const command of COMMANDS)
    (redisMock.sysRedis[command] as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      redis[command] as (...args: unknown[]) => unknown
    );
  vi.useFakeTimers({ toFake: ['Date'] });
  tick();
});
afterEach(() => vi.useRealTimers());

describe('mergeQueue during a consumer checkout', () => {
  it('🔴 leaves an uncommitted checkout to its consumer: nothing processed twice, nothing lost', async () => {
    await addToQueue(KEY, [1, 2, 3]);
    tick();
    const consumer = await checkoutQueue(KEY);
    expect(consumer.content.sort()).toEqual([1, 2, 3]);

    tick();
    await addToQueue(KEY, [4]);
    tick();
    await mergeQueue(KEY);
    tick();
    await consumer.commit();

    expect(await queued()).toEqual([4]);
  });

  it('merges again once a crashed consumer’s lease has expired, keeping its ids', async () => {
    await addToQueue(KEY, [1, 2]);
    tick();
    await checkoutQueue(KEY); // never committed
    tick();
    await addToQueue(KEY, [3]);

    tick();
    await mergeQueue(KEY);
    expect(await queued()).toEqual([1, 2, 3]);

    tick(2 * 60 * 60 * 1000);
    await mergeQueue(KEY);
    expect(await queued()).toEqual([1, 2, 3]);
    expect(redis.hasZset(LEASE)).toBe(false);
    tick();
    const next = await checkoutQueue(KEY);
    expect(next.content.sort()).toEqual([1, 2, 3]);
  });

  it('holds off while a second consumer of the key is still uncommitted', async () => {
    await addToQueue(KEY, [1]);
    tick();
    const first = await checkoutQueue(KEY);
    tick();
    await addToQueue(KEY, [2]);
    tick();
    const second = await checkoutQueue(KEY);
    expect(second.content).toContain(2);

    tick();
    await first.commit();
    tick();
    await addToQueue(KEY, [3]);
    tick();
    await mergeQueue(KEY);
    tick();
    await second.commit();

    expect(await queued()).toEqual([3]);
  });

  it('lets merges run past a consumer that found its queue empty and never committed', async () => {
    // Two empty runs that never commit, as the webhook processors do; each leaves a head bucket.
    await checkoutQueue(KEY);
    tick();
    await checkoutQueue(KEY);
    tick();
    await addToQueue(KEY, [1, 2]);
    const bucketsBefore = (await redis.hGet(REDIS_SYS_KEYS.QUEUES.BUCKETS, KEY))!.split(',').length;
    tick();
    await mergeQueue(KEY);
    const bucketsAfter = (await redis.hGet(REDIS_SYS_KEYS.QUEUES.BUCKETS, KEY))!.split(',').length;
    expect(bucketsAfter).toBeLessThan(bucketsBefore);
    expect(await queued()).toEqual([1, 2]);
  });

  it('still hands the consumer its ids when the lease cannot be written', async () => {
    await addToQueue(KEY, [1, 2]);
    fail.add('zAdd');
    tick();
    const consumer = await checkoutQueue(KEY);
    expect(consumer.content.sort()).toEqual([1, 2]);
    await consumer.commit();
    expect(await queued()).toEqual([]);
  });

  it('skips the merge when the leases cannot be read', async () => {
    await addToQueue(KEY, [1]);
    tick();
    const consumer = await checkoutQueue(KEY);
    tick();
    await addToQueue(KEY, [2]);
    fail.add('zCount');
    tick();
    await mergeQueue(KEY);
    fail.delete('zCount');
    tick();
    await consumer.commit();
    expect(await queued()).toEqual([2]);
  });
});
