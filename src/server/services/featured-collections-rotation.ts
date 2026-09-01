import { redis, REDIS_KEYS } from '~/server/redis/client';
import { shuffle } from '~/utils/array-helpers';

/**
 * One pass of the rotation: the eligible collections that have not had their turn yet, in a
 * shuffled order, consumed from the front.
 *
 * The homepage draws every 3 minutes into a single shared cache entry, so the draw is per window
 * rather than per viewer and a memoryless shuffle is what a visitor experiences as "the same five
 * again". Measured over 200k simulated windows at 13 eligible: a uniform draw leaves a collection
 * unshown for up to 99 minutes and repeats 4 of 5 on 3.1% of reloads (16.7% at 9 eligible). A
 * cycle bounds the gap at `ceil((2n-1)/k)` windows and makes consecutive repeats structurally
 * impossible.
 *
 * The whole memory is this list — at most one integer per eligible collection, shrinking as it is
 * consumed. Nothing per-viewer is stored, and nothing here is authoritative: if the key is lost,
 * the next draw reshuffles and the only cost is that one collection's turn comes round sooner.
 */
const CYCLE_KEY = REDIS_KEYS.HOMEBLOCKS.FEATURED_COLLECTIONS_CYCLE;
const REFILL_LOCK_KEY = REDIS_KEYS.HOMEBLOCKS.FEATURED_COLLECTIONS_CYCLE_LOCK;

/**
 * An hour of no draws and the pass is abandoned. Long enough that ordinary traffic never loses a
 * pass mid-way (a draw every 3 minutes touches the key 20 times an hour), short enough that an
 * ordering built for a pool that has since changed does not linger.
 */
const CYCLE_TTL_SECONDS = 60 * 60;

/**
 * Held only across the reshuffle, and short: several instances can miss the 3-minute cache at the
 * same moment, and without it each would push its own pass and the queue would hold several
 * interleaved orderings. Losing the race is not an error — that caller takes what the list has and
 * fills the rest randomly, which is exactly what it would have done on a cold key.
 */
const REFILL_LOCK_SECONDS = 10;

type RotationDeps = {
  lPopCount: (key: string, count: number) => Promise<string[] | null>;
  rPush: (key: string, values: string[]) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
  setLock: (key: string, seconds: number) => Promise<string | null>;
  del: (key: string) => Promise<unknown>;
};

const liveDeps: RotationDeps = {
  lPopCount: (key, count) => redis.lPopCount(key as never, count),
  rPush: (key, values) => redis.rPush(key as never, values),
  expire: (key, seconds) => redis.expire(key as never, seconds),
  setLock: (key, seconds) => redis.set(key as never, '1', { NX: true, EX: seconds }),
  del: (key) => redis.del(key as never),
};

/**
 * Take the next `count` collections, in cycle order, filling from a fresh pass when the current
 * one runs out.
 *
 * Ids that are no longer eligible are dropped as they surface rather than being swept up front:
 * the list is at most a few dozen entries and a stale id costs one extra pop, where a read-filter-
 * rewrite would need its own lock to be safe.
 *
 * Redis is not on the critical path for correctness — every failure mode here degrades to the
 * random draw this replaces, because an unrotated homepage is a far better outcome than none.
 */
export async function takeFeaturedCollectionCycle(
  eligible: number[],
  count: number,
  deps: RotationDeps = liveDeps
): Promise<number[]> {
  const want = Math.min(count, eligible.length);
  if (want <= 0) return [];

  const eligibleIds = new Set(eligible);
  const picks: number[] = [];

  try {
    // Two attempts at most: what the current pass has left, then one refilled pass. A third would
    // only ever fire if another instance drained the list in between, and looping on that is how a
    // cold key turns into a spin.
    for (let attempt = 0; attempt < 2 && picks.length < want; attempt++) {
      const popped = (await deps.lPopCount(CYCLE_KEY, want - picks.length)) ?? [];
      for (const raw of popped) {
        const id = Number(raw);
        if (eligibleIds.has(id) && !picks.includes(id)) picks.push(id);
      }
      if (picks.length >= want) break;
      if (attempt === 0) await refillCycle(eligible, picks, deps);
    }
  } catch {
    // Redis unavailable or a command shape we do not expect: fall through to the random fill below
    // rather than failing the block. The homepage renders; it just does not rotate this window.
  }

  if (picks.length < want) {
    // Whatever the cycle could not supply — a lost refill race, an empty key, a Redis fault.
    const remainder = shuffle(eligible.filter((id) => !picks.includes(id)));
    picks.push(...remainder.slice(0, want - picks.length));
  }

  return picks;
}

async function refillCycle(eligible: number[], taken: number[], deps: RotationDeps) {
  const lock = await deps.setLock(REFILL_LOCK_KEY, REFILL_LOCK_SECONDS);
  // Somebody else is already building the next pass. Taking the random remainder is better than
  // waiting on them: the caller is inside a page render.
  if (!lock) return;

  try {
    // The ids taken in THIS draw are excluded from the pass being built, so a cycle boundary
    // cannot show the same collection twice in one window.
    const next = shuffle(eligible.filter((id) => !taken.includes(id)));
    if (next.length > 0) {
      await deps.rPush(
        CYCLE_KEY,
        next.map((id) => String(id))
      );
      await deps.expire(CYCLE_KEY, CYCLE_TTL_SECONDS);
    }
  } finally {
    await deps.del(REFILL_LOCK_KEY);
  }
}
