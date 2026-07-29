/**
 * Dedup + attribution helpers for the devalue-write fallback logger
 * (src/server/trpc.ts). Kept pure + standalone so the bound/normalize logic is
 * unit-testable without importing the heavyweight server `trpc.ts` module.
 *
 * WHY THIS EXISTS: a devalue-write fallback (a non-POJO response that fell back
 * to superjson — see `writeSerializeWithFallback`) is attributed via the
 * serialize ALS ctx, whose `path` is the RAW, client-controlled, comma-joined
 * batch string from `req.query.trpc` (e.g. `image.getInfinite,model.getById`).
 * Keying the dedup on that raw string has two defects:
 *   (a) a client can hit ONE offending procedure inside arbitrarily many batch
 *       framings (`offender,a` / `offender,b` / …), each a NEW key, defeating the
 *       "deduped so a hot offender can't flood Axiom" intent; and
 *   (b) the dedup Map is `set` but never evicted → unbounded growth on a
 *       long-lived module.
 * `fallbackDedupKeys` closes (a) by normalizing to the individual procedure(s);
 * `createFallbackDedup` closes (b) with a size cap + LRU drop-oldest eviction.
 */

/**
 * Normalize the client-controlled batch path to the SET of individual procedures
 * it names. The path is a comma-joined batch string, optionally '/'-joined when
 * the `[trpc]` catch-all segment arrives as an array (see `serializeCtxFromRequest`).
 * Splitting on BOTH separators and deduping means a single offending procedure
 * re-framed inside many batches collapses to one dedup key — so a hot offender
 * can no longer flood Axiom by varying its co-batched neighbours.
 *
 * Returns an order-preserving, de-duplicated list. Empty / whitespace-only input
 * collapses to `['unknown']` (mirrors the ctx-absent fallback).
 */
export function fallbackDedupKeys(rawPath: string): string[] {
  const parts = rawPath
    .split(/[,/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return ['unknown'];
  return Array.from(new Set(parts));
}

export interface FallbackDedup {
  /**
   * Should `key` be logged at `now`? Returns true at most once per `windowMs` per
   * key, recording the key (and refreshing its LRU recency) when it returns true.
   */
  shouldLog(key: string, now?: number): boolean;
  /** Current tracked-key count — never exceeds `maxSize`. For assertions/introspection. */
  size(): number;
}

/**
 * Windowed, SIZE-BOUNDED per-key dedup. A key logs at most once per `windowMs`;
 * the tracking Map is capped at `maxSize` with LRU drop-oldest eviction so a
 * long-lived module can't grow it unboundedly across distinct offenders.
 */
export function createFallbackDedup(opts: { windowMs: number; maxSize: number }): FallbackDedup {
  const { windowMs, maxSize } = opts;
  const lastLogged = new Map<string, number>();
  return {
    shouldLog(key: string, now: number = Date.now()): boolean {
      const last = lastLogged.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      // LRU refresh: delete-then-set moves the key to the most-recent position
      // (Map preserves insertion order). When at cap, evict the oldest (least
      // recently logged) key BEFORE inserting so size never exceeds maxSize.
      lastLogged.delete(key);
      if (lastLogged.size >= maxSize) {
        const oldest = lastLogged.keys().next().value;
        if (oldest !== undefined) lastLogged.delete(oldest);
      }
      lastLogged.set(key, now);
      return true;
    },
    size() {
      return lastLogged.size;
    },
  };
}
