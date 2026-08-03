// Environment-scoped prefix for CACHE redis keys.
//
// WHY: preview deployments run against the dev database but share the production cache
// instance. Cache keys carried no environment segment, so a page load on a preview could
// populate a key that production then served — dev-shaped data answering production reads,
// and preview traffic evicting production entries.
//
// 🔴 PRODUCTION MUST BE THE EMPTY STRING. `IS_PREVIEW` is set only on preview deployments
// and is unset everywhere else, so production keys stay byte-identical to what they are
// today. `applyCacheKeyPrefix` / `prefixCacheKey` return their argument UNCHANGED (same
// object identity for the key table) when the prefix is empty — production is a structural
// no-op, not a concatenation that happens to add nothing.
//
// WHY `process.env` DIRECTLY AND NOT THE PACKAGE ENV SCHEMA (./env): this value is needed at
// MODULE-EVAL time, because the key table (`REDIS_KEYS`) is a module-level const that is built
// long before any client is constructed — so there is no client-construction hook to inject it
// through. `loadRedisEnv()` is deliberately lazy so that a bare import of this package never
// touches process.env and never throws (build, scripts and tests all import it); calling it at
// module scope would break that invariant. A single literal comparison cannot throw and keeps
// it. The expression mirrors the app's own `isPreview` (src/env/other.ts) exactly, so there is
// one definition of "this is a preview" rather than two that can drift.
//
// This is CACHE-ONLY. The system client (REDIS_SYS_*/`REDIS_SYS_KEYS`) is untouched.
const PREVIEW_CACHE_KEY_PREFIX = 'preview:';

/**
 * The prefix applied to every cache key. Empty string in production — see the note above.
 * All preview deployments share one namespace, matching the fact that they already share one
 * dev database; there is deliberately no per-PR namespace and no env var to configure this.
 */
export const CACHE_KEY_PREFIX = process.env.IS_PREVIEW === 'true' ? PREVIEW_CACHE_KEY_PREFIX : '';

/**
 * Prefix a single cache key (or key glob) that was built on the fly rather than derived from
 * the `REDIS_KEYS` table — see `queryCache`/`queryCacheRaw`, the only such minters.
 *
 * Do NOT call this on a key already derived from `REDIS_KEYS`: those carry the prefix from the
 * table itself, and prefixing again yields `preview:preview:…`.
 */
export function prefixCacheKey<T extends string>(key: T): T {
  return (CACHE_KEY_PREFIX ? `${CACHE_KEY_PREFIX}${key}` : key) as T;
}

/**
 * Deep-copy a nested key table, prefixing every string leaf. Returns the input UNCHANGED when
 * the prefix is empty (production), so the production key table is literally the same object.
 *
 * The return type is the input type, which keeps the literal-string types of the `as const` key
 * table intact — `RedisKeyTemplateCache` and every `${REDIS_KEYS.X}:${id}` template type are
 * unaffected by this change. Only the runtime values differ, and only on preview.
 */
export function applyCacheKeyPrefix<T>(keys: T): T {
  if (!CACHE_KEY_PREFIX) return keys;
  return prefixDeep(keys) as T;
}

function prefixDeep(value: unknown): unknown {
  if (typeof value === 'string') return `${CACHE_KEY_PREFIX}${value}`;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = prefixDeep(v);
    return out;
  }
  return value;
}
