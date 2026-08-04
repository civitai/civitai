// Environment-scoped prefix for CACHE redis keys.
//
// WHY: several deployments share ONE cache instance. Cache keys carried no environment segment,
// so a page load on a non-production deployment could populate a key that production then served
// — foreign-shaped data answering production reads, and non-production traffic evicting
// production entries.
//
// 🔴 THE NAMESPACE IS EXPLICIT, NOT DERIVED FROM `IS_PREVIEW`. An earlier revision keyed this off
// `IS_PREVIEW === 'true'`. That is wrong, because `IS_PREVIEW` does not mean what a cache
// namespace needs it to mean:
//
//   * It is not one environment. At least two distinct deployment classes set it, and they run
//     against DIFFERENT databases — one against a scratch database, one against the PRODUCTION
//     database. Deriving the namespace from the flag would place both in the same `preview:`
//     namespace on different data, which is the exact bug this module exists to prevent, merely
//     relocated. For the deployment that runs against the production database it would also be a
//     net regression: its cache co-tenants are production today (consistent, same database), and
//     would become scratch-database deployments instead.
//   * It is overloaded. `IS_PREVIEW` also gates the auth path (see
//     src/server/auth/get-server-auth-session.ts) and page-level access (src/server/auth/
//     route-guard.ts). Flipping it to fix a cache problem would change live login behaviour.
//
// So the cache namespace gets its own variable and the two concerns are decoupled. Set
// `CACHE_KEY_NAMESPACE` per deployment:
//
//   unset / empty  → NO prefix. Production.
//   'preview'      → ephemeral per-PR deployments (they share one scratch database)
//   'next'         → the standing non-production deployment
//
// 🔴 PRODUCTION MUST BE THE EMPTY PREFIX, and structurally so. `applyCacheKeyPrefix` /
// `prefixCacheKey` return their argument UNCHANGED (same object identity for the key table) when
// the namespace is unset — production is a no-op, not a concatenation that happens to add
// nothing. A non-empty prefix in production would re-key the entire cache and cold-start it.
//
// WHY `process.env` DIRECTLY AND NOT THE PACKAGE ENV SCHEMA (./env): this value is needed at
// MODULE-EVAL time, because the key table (`REDIS_KEYS`) is a module-level const that is built
// long before any client is constructed — so there is no client-construction hook to inject it
// through. `loadRedisEnv()` is deliberately lazy so that a bare import of this package never
// touches process.env and never throws (build, scripts and tests all import it); calling it at
// module scope would break that invariant. Reading one optional string cannot throw and keeps it.
//
// This is CACHE-ONLY. The system client (REDIS_SYS_*/`REDIS_SYS_KEYS`) is untouched.
const RAW_NAMESPACE = process.env.CACHE_KEY_NAMESPACE?.trim() ?? '';

/**
 * The configured cache namespace, or `''` in production. Exported for diagnostics; callers should
 * prefer `CACHE_KEY_PREFIX` / `prefixCacheKey`, which carry the separator.
 */
export const CACHE_KEY_NAMESPACE = RAW_NAMESPACE;

/**
 * The prefix applied to every cache key — `'<namespace>:'`, or `''` in production (see above).
 *
 * The separator lives here rather than in the deployment's value so a namespace can never be
 * configured without it (`CACHE_KEY_NAMESPACE=preview` and `=preview:` would otherwise produce
 * two different keyspaces).
 */
export const CACHE_KEY_PREFIX = RAW_NAMESPACE ? `${RAW_NAMESPACE}:` : '';

// Misconfiguration guard. A deployment that announces itself as non-production but sets no cache
// namespace is silently sharing production's keyspace — the damaging direction, and invisible
// from the outside until production serves foreign data.
//
// 🔴 DELIBERATELY LOG-ONLY, NEVER THROW. This runs at module eval, on the import path of every
// process that touches redis, so throwing here would fail boot — and at least one deployment sets
// `IS_PREVIEW=true` today and will not carry `CACHE_KEY_NAMESPACE` until its configuration is
// updated separately. Taking that deployment down to enforce a cache-hygiene invariant is a worse
// outcome than the mis-namespacing this warns about.
if (!RAW_NAMESPACE && process.env.IS_PREVIEW === 'true') {
  // eslint-disable-next-line no-console
  console.error(
    '🔴 CACHE_KEY_NAMESPACE IS UNSET on a deployment with IS_PREVIEW=true. This deployment is ' +
      "sharing PRODUCTION's cache keyspace: it can read production cache entries, overwrite " +
      'them with its own data, and evict them. Set CACHE_KEY_NAMESPACE (e.g. "preview" or ' +
      '"next") on this deployment. See packages/civitai-redis/src/cache-key-prefix.ts.'
  );
}

/**
 * A nested table of cache-key literals. String leaves only — see `applyCacheKeyPrefix`.
 */
export type CacheKeyTable = { readonly [key: string]: string | CacheKeyTable };

/**
 * Prefix a single cache key (or key glob) that was built on the fly rather than derived from
 * the `REDIS_KEYS` table.
 *
 * Do NOT call this on a key already derived from `REDIS_KEYS`: those carry the prefix from the
 * table itself, and prefixing again yields `preview:preview:…`.
 */
export function prefixCacheKey<T extends string>(key: T): T {
  return (CACHE_KEY_PREFIX ? `${CACHE_KEY_PREFIX}${key}` : key) as T;
}

/**
 * Deep-copy a nested key table, prefixing every string leaf. Returns the input UNCHANGED when
 * the namespace is unset (production), so the production key table is literally the same object.
 *
 * The return type is the input type, which keeps the literal-string types of the `as const` key
 * table intact — `RedisKeyTemplateCache` and every `${REDIS_KEYS.X}:${id}` template type are
 * unaffected by this change. Only the runtime values differ, and only when a namespace is set.
 *
 * 🔴 The `CacheKeyTable` constraint is load-bearing: it rejects an ARRAY leaf at compile time.
 * The rebuild below walks objects generically, and an array reached through the object branch
 * would come back as a plain object (`{0: …, 1: …}`), silently changing the table's shape. That
 * failure would be invisible in production — where this function returns early — and would only
 * appear in a namespaced environment. `prefixDeep` also preserves arrays at runtime as a second
 * line of defence, since the constraint can be bypassed with a cast.
 */
export function applyCacheKeyPrefix<T extends CacheKeyTable>(keys: T): T {
  if (!CACHE_KEY_PREFIX) return keys;
  return prefixDeep(keys) as T;
}

function prefixDeep(value: unknown): unknown {
  if (typeof value === 'string') return `${CACHE_KEY_PREFIX}${value}`;
  // Before the object branch: `Object.entries` on an array would rebuild it as a plain object.
  if (Array.isArray(value)) return value.map(prefixDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = prefixDeep(v);
    return out;
  }
  return value;
}
