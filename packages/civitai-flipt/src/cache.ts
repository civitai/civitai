// TTL cache with generational rotation instead of full-clear eviction. On overflow the current
// generation becomes the "previous" one (the old previous is dropped) and a fresh generation
// starts, so hot keys survive at least one rotation and we never thrash to worse-than-no-cache
// under high key cardinality. Single-threaded, so Map ops need no locking.
//
// Steady-state live entries are bounded to ~2x maxEntries; a burst of distinct promoting reads
// with no intervening insert can transiently reach ~4x before the next insert rotates — still
// bounded, and entries are tiny.

type Entry<T> = { value: T; expiresAt: number };

/**
 * Cumulative, process-lifetime counters. Monotonic (never reset), so a scraper can
 * `rate()` them.
 *
 * 🔴 `expiredMisses` and `rotations` are the POINT of this struct, not decoration —
 * they answer a question a bare hit rate cannot: **is the cache TTL-bound or
 * capacity-bound?** The two have opposite remedies and a hit rate alone is
 * consistent with either.
 *
 *   - misses dominated by `expiredMisses` (the key WAS present, its TTL had
 *     lapsed)              -> TTL-bound   -> raising the TTL recovers them.
 *   - `rotations` climbing (inserts overflowing `maxEntries`, so a whole
 *     generation is discarded)  -> capacity-bound -> raising the TTL recovers
 *     NOTHING, because entries are evicted before they can expire. Raise
 *     `maxEntries` instead.
 *
 * A miss that is neither (key absent from both generations) is cold or was dropped
 * by an earlier rotation; those two are not separable without retaining evicted
 * keys, which would defeat the eviction. So treat `misses - expiredMisses` as an
 * upper bound on cold traffic, not as a measurement of it.
 */
export type TtlCacheStats = {
  hits: number;
  misses: number;
  /** Subset of `misses` where the key was found but its TTL had lapsed. */
  expiredMisses: number;
  /** Generation rotations, i.e. how many times `maxEntries` overflowed. */
  rotations: number;
  /** Live entries right now, across both generations. Instantaneous, not cumulative. */
  size: number;
};

export class TtlCache<T> {
  private current = new Map<string, Entry<T>>();
  private previous = new Map<string, Entry<T>>();
  private hits = 0;
  private misses = 0;
  private expiredMisses = 0;
  private rotations = 0;

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string, now: number): { hit: boolean; value?: T } {
    let sawExpired = false;
    const cur = this.current.get(key);
    if (cur) {
      if (cur.expiresAt > now) {
        this.hits++;
        return { hit: true, value: cur.value };
      }
      this.current.delete(key);
      sawExpired = true;
    }
    const prev = this.previous.get(key);
    if (prev) {
      if (prev.expiresAt > now) {
        // Promote into the current generation so hot keys aren't lost on rotate.
        this.previous.delete(key);
        this.current.set(key, prev);
        this.hits++;
        return { hit: true, value: prev.value };
      }
      this.previous.delete(key);
      sawExpired = true;
    }
    this.misses++;
    if (sawExpired) this.expiredMisses++;
    return { hit: false };
  }

  set(key: string, value: T, now: number): void {
    if (this.ttlMs === 0) return;
    if (this.current.size >= this.maxEntries) {
      this.previous = this.current;
      this.current = new Map();
      this.rotations++;
    }
    this.current.set(key, { value, expiresAt: now + this.ttlMs });
  }

  /** Snapshot for observability. Pure read — never mutates or expires anything. */
  stats(): TtlCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      expiredMisses: this.expiredMisses,
      rotations: this.rotations,
      size: this.current.size + this.previous.size,
    };
  }
}

// Build a collision-proof cache key. Components are URI-encoded so that a `|`, `&`, or `=` inside
// an entityId or context value can't alias another key.
export function fliptCacheKey(
  flag: string,
  entityId: string,
  context: Record<string, string>
): string {
  const keys = Object.keys(context);
  if (keys.length === 0) return `${flag}|${encodeURIComponent(entityId)}`;
  const ctx = keys
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(context[k])}`)
    .join('&');
  return `${flag}|${encodeURIComponent(entityId)}|${ctx}`;
}
