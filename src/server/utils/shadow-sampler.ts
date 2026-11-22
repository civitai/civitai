/**
 * Pieces shared by the shadow samplers (`~/server/trpc/feed-go-shadow`,
 * `~/server/beacon/beacon-go-shadow`, the listings read-model shadow): reading their numeric env
 * knobs, the per-endpoint per-second budget, and a per-minute cap on their log lines. Import-free.
 */

/**
 * A numeric env value clamped to [min, max]; `fallback` when unset, blank or not a finite number.
 */
export function envNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * One token bucket per endpoint, each refilling at `maxPerSecond` on the clock `now` (milliseconds,
 * monotonic in production: `performance.now`). Each starts full and holds at most one second's worth,
 * and at least one token, so a rate below 1/s still admits a sample. `take` spends a token and
 * reports whether there was one.
 */
export function createPerSecondBuckets<E extends string>(
  endpoints: readonly E[],
  maxPerSecond: number,
  now: () => number
): { take(endpoint: E): boolean } {
  const cap = Math.max(1, maxPerSecond);
  const buckets = {} as Record<E, { tokens: number; refilledAt?: number }>;
  for (const e of endpoints) buckets[e] = { tokens: cap };

  function take(endpoint: E): boolean {
    const bucket = buckets[endpoint];
    const t = now();
    if (bucket.refilledAt !== undefined)
      bucket.tokens = Math.min(
        cap,
        bucket.tokens + ((t - bucket.refilledAt) / 1000) * maxPerSecond
      );
    bucket.refilledAt = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  return { take };
}

/**
 * At most `perMinute` calls of `fn` in any minute (fixed one-minute windows, on the clock `nowMs`,
 * milliseconds); the rest are dropped.
 */
export function rateLimited<T>(
  fn: (x: T) => void,
  perMinute: number,
  nowMs: () => number
): (x: T) => void {
  let windowStart = Number.NEGATIVE_INFINITY;
  let used = 0;
  return (x) => {
    const t = nowMs();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      used = 0;
    }
    if (used >= perMinute) return;
    used++;
    fn(x);
  };
}
