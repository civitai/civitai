/**
 * Per-(client address, app) token bucket for the custom-events beacon.
 *
 * IN MEMORY, PER PROCESS. With N server processes behind a load balancer a caller can reach up to
 * N times these numbers, so this bounds what one process will accept and write; it is not an
 * exact global quota. It needs no network round trip, which is what lets it run before the
 * session is resolved.
 *
 * The numbers follow the batch contract rather than a guess at human behaviour: one batch carries
 * at most `BLOCK_EVENT_BATCH_MAX` rows, so a burst smaller than that would drop part of a
 * well-formed batch. Viewers behind one shared address share a bucket.
 */
/** Bucket capacity: two full batches. */
export const BLOCK_EVENT_RATE_BURST = 100;
/** Sustained refill, in events per second. */
export const BLOCK_EVENT_RATE_PER_SECOND = 10;
/**
 * Most buckets held at once. Reaching it evicts the least recently used bucket, which hands that
 * key a full bucket again on its next event, so the cap trades a little accuracy under a key
 * flood for a hard memory bound.
 */
export const BLOCK_EVENT_RATE_MAX_KEYS = 20_000;

type Bucket = { tokens: number; at: number };

export type BlockEventRateLimiter = {
  /** Take up to `want` tokens for `key`; returns how many were granted (0..want). */
  take(key: string, want: number, nowMs?: number): number;
  size(): number;
};

export function createBlockEventRateLimiter(
  opts: { burst?: number; perSecond?: number; maxKeys?: number } = {}
): BlockEventRateLimiter {
  const burst = opts.burst ?? BLOCK_EVENT_RATE_BURST;
  const perSecond = opts.perSecond ?? BLOCK_EVENT_RATE_PER_SECOND;
  const maxKeys = opts.maxKeys ?? BLOCK_EVENT_RATE_MAX_KEYS;
  // A Map iterates in insertion order, so re-inserting on every touch keeps the least recently
  // used key first.
  const buckets = new Map<string, Bucket>();

  return {
    take(key, want, nowMs = Date.now()) {
      const existing = buckets.get(key);
      let bucket: Bucket;
      if (existing) {
        // A clock that steps backwards must not mint tokens: no refill for negative time, and
        // the bucket keeps its later timestamp so the step forward again is not counted either.
        const at = Math.max(existing.at, nowMs);
        const elapsedSeconds = (at - existing.at) / 1000;
        bucket = { tokens: Math.min(burst, existing.tokens + elapsedSeconds * perSecond), at };
        buckets.delete(key);
      } else {
        bucket = { tokens: burst, at: nowMs };
      }
      const granted = Math.max(0, Math.min(want, Math.floor(bucket.tokens)));
      bucket.tokens -= granted;
      buckets.set(key, bucket);
      if (buckets.size > maxKeys) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
      return granted;
    },
    size: () => buckets.size,
  };
}

let shared: BlockEventRateLimiter | undefined;

/** The process-wide limiter the beacon uses. */
export function blockEventRateLimiter(): BlockEventRateLimiter {
  return (shared ??= createBlockEventRateLimiter());
}
