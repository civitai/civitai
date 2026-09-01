import { redis, REDIS_KEYS } from '~/server/redis/client';
import { logToAxiom } from '~/server/logging/client';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

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
 *
 * ⚠️ Two limits on how strongly this can be stated, both measured rather than assumed:
 *
 * - **The bound is per DRAW, not per wall-clock window.** The block's cache entry has no
 *   single-flight, so every request arriving during a 3-minute miss runs its own draw and only one
 *   result is kept. At three concurrent consumers the gap stretched from 4 windows to 23 in
 *   simulation, and 4-of-5 repeats reappeared at 3.1%. Serialising that fill is a change to the
 *   home-block cache, not to this file.
 * - **A repeat is not structurally impossible, only rare.** A new pass excludes the draw that
 *   built it, so a boundary cannot repeat — but the pass before that is fair game, and the random
 *   fallback (lost lock, cold key, slow Redis) does not consume a turn at all.
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

/**
 * A whole draw, not one command. Long enough that a healthy round trip never trips it, short
 * enough that a page render is never parked waiting to be told which collections to show.
 */
const ROTATION_DEADLINE_MS = 250;

/**
 * Fisher-Yates, locally, rather than `~/utils/array-helpers`'s `shuffle` — that one is
 * `sort(() => Math.random() - 0.5)`, an inconsistent comparator whose permutation distribution is
 * strongly biased under V8's sort. The ordering guarantee here survives a biased shuffle, but the
 * fairness argument for the scheme does not, and the simulation behind it assumed a uniform one.
 * Fixing the shared helper is a repo-wide change and not this PR's business.
 */
function shufflePass(ids: number[]) {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type RotationDeps = {
  lPopCount: (key: string, count: number) => Promise<string[] | null>;
  lLen: (key: string) => Promise<number>;
  rPush: (key: string, values: string[]) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
  setLock: (key: string, token: string, seconds: number) => Promise<string | null>;
  readKey: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<unknown>;
};

/**
 * Exported for tests. Every test passes its own `deps`, so without this the actual node-redis
 * bindings — `NX: true` on the lock, RPUSH rather than LPUSH — are the one part of the file no
 * assertion can reach, and a mutation there would be invisible.
 */
export const liveRotationDeps: RotationDeps = {
  lPopCount: (key, count) => redis.lPopCount(key as never, count),
  lLen: (key) => redis.lLen(key as never),
  rPush: (key, values) => redis.rPush(key as never, values),
  expire: (key, seconds) => redis.expire(key as never, seconds),
  setLock: (key, token, seconds) => redis.set(key as never, token, { NX: true, EX: seconds }),
  readKey: (key) => redis.get(key as never),
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
  deps: RotationDeps = liveRotationDeps
): Promise<number[]> {
  const want = Math.min(count, eligible.length);
  if (want <= 0) return [];

  // The rotation is a nicety; the page is not. A stalled Redis is not a failed one, so the
  // try/catch below never fires for it — the cluster client's own deadline is 15s per command and
  // a refill serialises six of them. Race the whole thing instead and let the random draw win.
  return withTimeoutFallback(
    drawFromCycle(eligible, want, deps),
    ROTATION_DEADLINE_MS,
    shufflePass(eligible).slice(0, want)
  );
}

async function drawFromCycle(
  eligible: number[],
  want: number,
  deps: RotationDeps
): Promise<number[]> {
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

    // Top the pass up if this draw drained it, excluding what this draw showed.
    //
    // Without this the exclusion has no memory across a draw boundary: when a pass empties
    // EXACTLY — which happens whenever the eligible count is a multiple of the draw size, and 10
    // of 5 sits inside the range the pool actually occupies — the next draw refills from scratch
    // with nothing taken, so the new pass contains the five just shown. Hypergeometric odds of
    // repeating 4 of 5 across that boundary: 10.3%, which is the scheme this replaces.
    if (picks.length >= want && (await deps.lLen(CYCLE_KEY)) < want)
      await refillCycle(eligible, picks, deps);
  } catch (error) {
    // Redis unavailable or a command shape we do not expect: fall through to the random fill below
    // rather than failing the block. The homepage renders; it just does not rotate this window.
    //
    // Logged rather than swallowed, because the degraded state is invisible from the outside: a
    // page that stopped rotating looks exactly like one that is rotating, so a silent catch here
    // is a green nobody can falsify.
    logToAxiom({
      type: 'redis-degraded',
      name: 'featured-collections-rotation',
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
  }

  if (picks.length < want) {
    // Whatever the cycle could not supply — a lost refill race, an empty key, a Redis fault.
    const remainder = shufflePass(eligible.filter((id) => !picks.includes(id)));
    picks.push(...remainder.slice(0, want - picks.length));
  }

  return picks;
}

async function refillCycle(eligible: number[], taken: number[], deps: RotationDeps) {
  // Fenced with a token. `DistributedLock` in server/utils would also fence this, but it retries
  // (10 attempts, 100ms apart) — correct for work that must happen, wrong inside a page render,
  // where the right answer to a held lock is to skip the refill and draw at random.
  const token = `${Date.now()}-${Math.random()}`;
  const lock = await deps.setLock(REFILL_LOCK_KEY, token, REFILL_LOCK_SECONDS);
  // Somebody else is already building the next pass. Taking the random remainder is better than
  // waiting on them: the caller is inside a page render.
  if (!lock) return;

  // The pass is REPLACED, not appended to. Appending stacked two passes whenever the list still
  // held entries — a stale id at the head under-fills a draw without emptying the list — and the
  // ids still queued then appeared in the new pass as well, so a collection could be drawn twice
  // and one shown in this window could return in the next. Rewriting cannot lose a turn: anything
  // still queued has not been shown, so it is in `eligible` and lands in the new pass anyway.
  //
  // The ids taken in THIS draw are excluded, which is what keeps a boundary-spanning draw and the
  // draw after it from repeating.
  const next = shufflePass(eligible.filter((id) => !taken.includes(id)));
  if (next.length === 0) return;

  try {
    await deps.del(CYCLE_KEY);
    await deps.rPush(
      CYCLE_KEY,
      next.map((id) => String(id))
    );
    // EXPIRE on a missing key sets nothing and returns 0 — the pass would then live forever, which
    // is the one invariant the docblock claims. Cheap to check, silent to assume.
    if ((await deps.expire(CYCLE_KEY, CYCLE_TTL_SECONDS)) !== 1)
      logToAxiom({
        type: 'redis-degraded',
        name: 'featured-collections-rotation',
        message: 'cycle pass written without a TTL',
      }).catch(() => null);
  } finally {
    // Released only if we still hold it. An unconditional delete is not fenced: a refill that
    // overran the 10s TTL would delete whoever holds the lock NOW, and two concurrent rewrites are
    // exactly what the lock exists to prevent.
    if ((await deps.readKey(REFILL_LOCK_KEY)) === token) await deps.del(REFILL_LOCK_KEY);
  }
}
