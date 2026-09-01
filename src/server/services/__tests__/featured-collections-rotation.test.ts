import { describe, expect, it, vi } from 'vitest';
import { takeFeaturedCollectionCycle } from '~/server/services/featured-collections-rotation';

/**
 * An in-memory stand-in for the three list commands and the lock, so the tests exercise the real
 * cycle arithmetic rather than assertions about which commands were called.
 *
 * `lPopCount` pops from the front and returns `null` on an empty key, which is what node-redis
 * does — the production code treats that as "the pass is spent", so a fake returning `[]` instead
 * would hide a branch.
 */
function fakeRedis({ lockHeldByAnother = false }: { lockHeldByAnother?: boolean } = {}) {
  const state = { list: [] as string[], ttl: null as number | null, locked: false };
  const deps = {
    lPopCount: vi.fn(async (_key: string, count: number) => {
      if (state.list.length === 0) return null;
      return state.list.splice(0, count);
    }),
    rPush: vi.fn(async (_key: string, values: string[]) => state.list.push(...values)),
    expire: vi.fn(async (_key: string, seconds: number) => {
      state.ttl = seconds;
      return 1;
    }),
    setLock: vi.fn(async () => {
      if (lockHeldByAnother || state.locked) return null;
      state.locked = true;
      return 'OK';
    }),
    del: vi.fn(async () => {
      state.locked = false;
      return 1;
    }),
  };
  return { state, deps };
}

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
    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);
    deps.rPush.mockClear();
    const spanning = await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    expect(spanning).toHaveLength(3);
    expect(new Set(spanning).size).toBe(3);
    // The refill legitimately supplies the rest of this draw, so most of what it pushed WILL be in
    // the result. The invariant is narrower: the id already taken before the refill — the first
    // one, since picks accumulate in order — must not be pushed back into the new pass.
    const pushed = (deps.rPush.mock.calls[0]?.[1] ?? []).map(Number);
    expect(pushed).not.toHaveLength(0);
    expect(pushed).not.toContain(spanning[0]);
  });

  it('puts an hour on the pass so an idle key cannot pin a stale ordering', async () => {
    const { state, deps } = fakeRedis();

    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    expect(state.ttl).toBe(60 * 60);
  });

  it('drops ids that are no longer eligible and still fills the draw', async () => {
    const { state, deps } = fakeRedis();
    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    // Two collections go stale between draws; their ids are still sitting in the pass. The queue
    // holds strings, so these have to be compared as numbers — the first version of this test
    // compared them raw, filtered nothing, and passed for any implementation.
    const stale = state.list.slice(0, 2).map(Number);
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
    const { deps } = fakeRedis();
    deps.rPush.mockRejectedValueOnce(new Error('write failed'));

    await takeFeaturedCollectionCycle(ELIGIBLE, 3, deps);

    expect(deps.del).toHaveBeenCalled();
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
    const { state, deps } = fakeRedis();
    await takeFeaturedCollectionCycle(ELIGIBLE, 1, deps);
    const queuedBefore = state.list.length;

    await takeFeaturedCollectionCycle([Number(state.list[0])], 5, deps);

    expect(state.list.length).toBe(queuedBefore - 1);
  });
});
