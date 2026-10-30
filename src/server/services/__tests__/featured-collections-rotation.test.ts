import { describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  liveRotationDeps,
  takeFeaturedCollectionCycle,
} from '~/server/services/featured-collections-rotation';

/**
 * An in-memory stand-in for the three list commands and the lock, so the tests exercise the real
 * cycle arithmetic rather than assertions about which commands were called.
 *
 * `lPopCount` pops from the front and returns `null` on an empty key, which is what node-redis
 * does — the production code treats that as "the pass is spent", so a fake returning `[]` instead
 * would hide a branch.
 */
function fakeRedis({ lockHeldByAnother = false }: { lockHeldByAnother?: boolean } = {}) {
  // Key-addressed on purpose. A fake that ignores the key argument cannot tell a DEL of the lock
  // from a DEL of the pass — and deleting the pass in the refill's `finally` would degrade the
  // cycle to the random draw permanently, with every assertion still green.
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();
  const locks = new Map<string, string>();
  const list = (key: string) => lists.get(key) ?? [];

  const deps = {
    lPopCount: vi.fn(async (key: string, count: number) => {
      const held = list(key);
      if (held.length === 0) return null;
      const taken = held.splice(0, count);
      lists.set(key, held);
      return taken;
    }),
    lLen: vi.fn(async (key: string) => list(key).length),
    rPush: vi.fn(async (key: string, values: string[]) => {
      const held = list(key);
      held.push(...values);
      lists.set(key, held);
      return held.length;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      // Real EXPIRE on a missing key sets nothing and returns 0, so an `expire` hoisted above the
      // push would silently never apply.
      if (list(key).length === 0) return 0;
      ttls.set(key, seconds);
      return 1;
    }),
    setLock: vi.fn(async (key: string, token: string) => {
      if (lockHeldByAnother || locks.has(key)) return null;
      locks.set(key, token);
      return 'OK';
    }),
    readKey: vi.fn(async (key: string) => locks.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      locks.delete(key);
      lists.delete(key);
      ttls.delete(key);
      return 1;
    }),
  };
  return { lists, ttls, locks, deps };
}

const CYCLE_KEY = 'home-blocks:featured-collections:cycle';
const LOCK_KEY = 'home-blocks:featured-collections:cycle-lock';

const ELIGIBLE = [11, 22, 33, 44, 55, 66, 77];

describe('takeFeaturedCollectionCycle', () => {
  it('gives every collection a turn before repeating any', async () => {
    const { deps } = fakeRedis();
    const seen: number[] = [];

    // 7 eligible, 3 per draw: the first two draws plus one from the third complete a pass.
    for (let draw = 0; draw < 2; draw++)
      seen.push(...(await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps)));

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('never shows the same collection twice in one draw, even across a pass boundary', async () => {
    const { deps } = fakeRedis();

    // Draws of 3 from a pool of 7 leave one item in the pass before the third draw, so that draw
    // spans a refill. Asserted on what the refill PUSHED rather than on the ids that came back:
    // a re-added id only duplicates when it happens to land in the remaining pops, so asserting
    // on the result is a coin flip that passes most of the time with the exclusion removed.
    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);
    const second = await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);
    const spanning = await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    expect(spanning).toHaveLength(3);
    expect(new Set(spanning).size).toBe(3);
    // The draw that spans a refill must not repeat the one before it either: the new pass excludes
    // what the refill's own draw took, and a rewritten pass cannot hold a queued duplicate.
    expect(spanning.filter((id) => second.includes(id))).toEqual([]);
    const pushed = (deps.rPush.mock.calls.at(-1)?.[1] ?? []).map(Number);
    expect(pushed).not.toHaveLength(0);
    expect(new Set(pushed).size).toBe(pushed.length);
  });

  it('puts an hour on the pass so an idle key cannot pin a stale ordering', async () => {
    const { ttls, deps } = fakeRedis();

    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    expect(ttls.get(CYCLE_KEY)).toBe(60 * 60);
  });

  it('drops ids that are no longer eligible and still fills the draw', async () => {
    const { lists, deps } = fakeRedis();
    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    // Two collections go stale between draws; their ids are still sitting in the pass. The queue
    // holds strings, so these have to be compared as numbers — the first version of this test
    // compared them raw, filtered nothing, and passed for any implementation.
    const stale = (lists.get(CYCLE_KEY) ?? []).slice(0, 2).map(Number);
    expect(stale).toHaveLength(2);
    const stillEligible = ELIGIBLE.filter((id) => !stale.includes(id));
    const picks = await takeFeaturedCollectionCycle(stillEligible, 3, deps);

    expect(picks).toHaveLength(3);
    expect(picks.every((id) => stillEligible.includes(id))).toBe(true);
  });

  it('still returns a full draw when another instance is refilling', async () => {
    // Several instances can miss the 3-minute cache together. Losing the refill race must not
    // return a short list — the page renders either way, it just does not rotate this window.
    const { deps } = fakeRedis({ lockHeldByAnother: true });

    const picks = await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    expect(picks).toHaveLength(3);
    expect(new Set(picks).size).toBe(3);
    expect(deps.rPush).not.toHaveBeenCalled();
  });

  it('still returns a full draw when Redis is down', async () => {
    const down = {
      lPopCount: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      lLen: vi.fn(async () => 0),
      readKey: vi.fn(async () => null),
      rPush: vi.fn(async () => 0),
      expire: vi.fn(async () => 1),
      setLock: vi.fn(async () => null),
      del: vi.fn(async () => 1),
    };

    const picks = await takeFeaturedCollectionCycle(ELIGIBLE, 3, down);

    expect(picks).toHaveLength(3);
    expect(new Set(picks).size).toBe(3);
  });

  it('releases the refill lock even when the push fails', async () => {
    const { locks, deps } = fakeRedis();
    deps.rPush.mockRejectedValueOnce(new Error('write failed'));

    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    expect(deps.del).toHaveBeenCalledWith(LOCK_KEY);
    expect(locks.has(LOCK_KEY)).toBe(false);
  });

  it('does not release a lock it no longer holds', async () => {
    // A refill that overran the 10s TTL would otherwise delete whoever holds the lock now, and two
    // concurrent rewrites are the thing the lock exists to prevent.
    const { locks, deps } = fakeRedis();
    deps.rPush.mockImplementationOnce(async () => {
      locks.set(LOCK_KEY, 'someone-elses-token');
      return 1;
    });

    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    expect(deps.del).not.toHaveBeenCalledWith(LOCK_KEY);
    expect(locks.get(LOCK_KEY)).toBe('someone-elses-token');
  });

  // The pass empties EXACTLY whenever the eligible count is a multiple of the draw size, and the
  // pool has sat at 10 eligible. Before the top-up, the next draw refilled with nothing excluded,
  // so the fresh pass contained the five just shown — 10.3% odds of repeating 4 of 5, which is the
  // scheme this replaces. ELIGIBLE is 7 and every other test draws 3, so none of them can see it.
  it('does not repeat across a pass that empties exactly', async () => {
    const tenEligible = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const { deps } = fakeRedis();

    const first = await takeFeaturedCollectionCycle(tenEligible, 5, deps);
    const second = await takeFeaturedCollectionCycle(tenEligible, 5, deps);
    const third = await takeFeaturedCollectionCycle(tenEligible, 5, deps);

    expect(new Set([...first, ...second]).size).toBe(10);
    expect(third.filter((id) => second.includes(id))).toEqual([]);
  });

  // A fixed pass order would satisfy every other assertion here — same ids, same turns — while the
  // homepage showed the same five in the same sequence forever. Two cold starts must differ.
  it('shuffles each pass rather than dealing a fixed order', async () => {
    const orders = new Set<string>();
    for (let run = 0; run < 12; run++) {
      const { deps } = fakeRedis();
      orders.add((await takeFeaturedCollectionCycle(ELIGIBLE, 7, deps)).join(','));
    }

    expect(orders.size).toBeGreaterThan(1);
  });

  // A stale id at the head under-fills a draw WITHOUT emptying the pass, so the refill runs while
  // entries are still queued. Appending there stacked two passes in one key: the queued ids appear
  // again in the new pass, so a collection can be drawn twice and one shown this window can return
  // in the next. Replacing the pass is what makes that impossible.
  it('does not leave a queued id sitting in the pass twice', async () => {
    const { lists, deps } = fakeRedis();
    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    const queued = () => (lists.get(CYCLE_KEY) ?? []).map(Number);
    const goneStale = queued()[0];
    const stillEligible = ELIGIBLE.filter((id) => id !== goneStale);

    const second = await takeFeaturedCollectionCycle(stillEligible, 3, deps);
    const afterRefill = queued();

    expect(new Set(afterRefill).size).toBe(afterRefill.length);
    expect(afterRefill.filter((id) => second.includes(id))).toEqual([]);
  });

  it('asks for no more than the pool holds', async () => {
    const { deps } = fakeRedis();

    expect(await takeFeaturedCollectionCycle([11, 22], 5, deps)).toHaveLength(2);
    expect(await takeFeaturedCollectionCycle([], 5, deps)).toEqual([]);
  });

  it('does not spend other collections turns to fill a short draw', async () => {
    // The pass is shared state. Popping `count` when only two collections are eligible would
    // discard the turns of everything else still queued behind them — invisible in the result,
    // and the next draw would skip those collections entirely.
    const { lists, deps } = fakeRedis();
    await takeFeaturedCollectionCycle(ELIGIBLE, 1, deps);
    const queued = () => lists.get(CYCLE_KEY) ?? [];
    const queuedBefore = queued().length;

    await takeFeaturedCollectionCycle([Number(queued()[0])], 5, deps);

    expect(queued().length).toBe(queuedBefore - 1);
  });

  // The live bindings are otherwise unreachable: every other test injects its own deps, so
  // `NX: true` becoming `NX: false` — every instance winning the lock and pushing its own pass —
  // and RPUSH becoming LPUSH would both be invisible.
  describe('live Redis bindings', () => {
    it('takes the refill lock only when nobody holds it', async () => {
      await liveRotationDeps.setLock('k', 'token', 10);

      expect(redisMock.redis.set).toHaveBeenCalledWith('k', 'token', { NX: true, EX: 10 });
    });

    it('appends a new pass to the tail so it is consumed in order', async () => {
      await liveRotationDeps.rPush('k', ['1', '2']);

      expect(redisMock.redis.rPush).toHaveBeenCalledWith('k', ['1', '2']);
      expect(redisMock.redis.lPush).not.toHaveBeenCalled();
    });
  });
});
