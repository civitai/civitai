import { logToAxiom } from '~/server/logging/client';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * A short-lived Redis copy of the ApiKey row the bearer path reads, keyed by the hash of the
 * presented credential. It removes the per-request primary read for personal and system keys.
 *
 * 🔴 THIS IS AN AUTH PATH, so it is narrower than the generic cache builders on purpose:
 *   - FAIL-SAFE, not fail-open. Any Redis error is a miss: the caller reads the database exactly as it
 *     did before this cache existed. A Redis failure can never ACCEPT a credential.
 *   - POSITIVE RESULTS ONLY. A credential the database does not know is never cached, so a key works
 *     the moment it is created.
 *   - NO STALE SERVING. `fetchThroughCache`'s bust only marks an entry stale, and a reader that loses
 *     the refill lock is still handed the old value; a revoked key must not be served at all.
 *     `createCachedObject` (non-SWR) does drop the entry on bust, but it is keyed by numeric id, its
 *     refill overwrites unconditionally, and its bust marker lives shorter than an entry — this cache
 *     is keyed by the credential hash and needs the two properties below.
 *   - EXPIRY IS RE-CHECKED ON EVERY HIT against the clock, and an entry never outlives `expiresAt`.
 *   - EVERY ENTRY EXPIRES WITHIN `API_KEY_PRINCIPAL_TTL_SECONDS` OF THE LOOKUP THAT READ THE ROW. It
 *     is written with an ABSOLUTE expiry (`PXAT` = lookup start + TTL), not a relative `EX`, which
 *     Redis would count from the write's arrival — and a write can wait in the client's offline queue
 *     through a reconnect. A slow or late-delivered refill is cached for less, or lands expired.
 *   - REVOCATION WRITES A TOMBSTONE (a plain SET, so it replaces any cached row) and refills use
 *     SET NX. Every refill that read the old row is then handled, whenever it reaches Redis:
 *       - before the tombstone: the tombstone overwrites it;
 *       - while the tombstone stands: NX refuses it;
 *       - after the tombstone expires: it is already past its absolute expiry. Its lookup read the
 *         old row, so it began before the revoke's commit, which precedes the tombstone write; its
 *         expiry is therefore before tombstone-write + TTL.
 *     So the tombstone only has to outlast the entry TTL plus clock skew: entry expiries are computed
 *     on each pod's clock and enforced on Redis's, while the tombstone's own lifetime is on Redis's.
 *     `API_KEY_TOMBSTONE_TTL_SECONDS` (2 min) is the 30 s TTL plus a 90 s skew margin. It is kept
 *     short on purpose: a spend-limit change (`setApiKeyBuzzLimit`) tombstones a LIVE key, which then
 *     reads the primary on every request for the tombstone's lifetime. (A plain delete instead of a
 *     tombstone would let a refill carrying the old row land.)
 *   - ONLY `User` and `System` keys with no OAuth client are cached. OAuth access tokens bypass the
 *     cache entirely: they are revoked from more places (including another service writing the table
 *     directly) and their request path reads the consent row anyway.
 *   - The spend limit is NOT served from here: `/api/v1/me`, the one place that hands `buzzLimit` to
 *     the orchestrator (which caches it in turn), reads it from the primary. See `readApiKeyBuzzLimit` in
 *     src/server/services/api-key.service.ts.
 *
 * Residual window, at most `API_KEY_PRINCIPAL_TTL_SECONDS` after the change (plus the writing pod's
 * clock skew), however late the cache write is delivered: a revocation whose tombstone write fails or
 * is lost in a cache-cluster failover, and any change made to the table without going through
 * `evictCachedApiKeys` — manual SQL, another service, a pod still running the previous release —
 * leave a cached row in place until it expires. Every write site in this repo is pinned by
 * `api-key-principal-cache.ledger.test.ts`.
 */
export const API_KEY_PRINCIPAL_TTL_SECONDS = 30;
// Entry TTL + a 90 s margin for pod-vs-Redis clock skew. See the module comment for why that is all
// a tombstone has to outlast.
export const API_KEY_TOMBSTONE_TTL_SECONDS = 2 * 60;
export const API_KEY_LAST_USED_DEBOUNCE_SECONDS = 60 * 60;

const CACHE_NAME = 'api-key-principal';

export type CachedApiKey = {
  id: number;
  userId: number;
  tokenScope: number;
  lastUsedAt: Date | null;
  buzzLimit: unknown;
  clientId: string | null;
  type: ApiKeyType;
  expiresAt: Date | null;
};

type Entry = { apiKey: CachedApiKey } | { revoked: true };

const entryKey = (hash: string) =>
  `${REDIS_KEYS.CACHES.API_KEY_PRINCIPAL}:${hash}` as RedisKeyTemplateCache;
const lastUsedKey = (id: number) =>
  `${REDIS_KEYS.CACHES.API_KEY_LAST_USED}:${id}` as RedisKeyTemplateCache;

/** Which rows may be cached at all. Anything else is read from the database every time. */
export function isCacheableApiKey(apiKey: Pick<CachedApiKey, 'clientId' | 'type'>) {
  return (
    apiKey.clientId === null &&
    (apiKey.type === ApiKeyType.User || apiKey.type === ApiKeyType.System)
  );
}

const isLive = (apiKey: CachedApiKey, now: Date) =>
  apiKey.expiresAt === null || new Date(apiKey.expiresAt).getTime() >= now.getTime();

export type ApiKeyCacheRead =
  /** A live cached row. */
  | { apiKey: CachedApiKey; fill: false }
  /** Nothing usable cached; `fill` says whether the caller may cache what the database returns. */
  | { apiKey: null; fill: boolean };

function report(error: unknown, operation: string) {
  logToAxiom(
    {
      type: 'error',
      name: 'api-key-principal-cache',
      operation,
      error: error instanceof Error ? error.message : String(error),
    },
    'civitai-prod'
  ).catch(() => undefined);
}

export async function readCachedApiKey(hash: string, now: Date): Promise<ApiKeyCacheRead> {
  let entry: Entry | null;
  try {
    entry = await redis.packed.get<Entry>(entryKey(hash));
  } catch (error) {
    report(error, 'read');
    // Redis is unavailable: read the database, and do not try to write to Redis either.
    return { apiKey: null, fill: false };
  }

  // Not counted as a miss here: this may be an OAuth token or an unknown credential, which the cache
  // never holds. A miss is counted in `cacheApiKey`, once the row is known to be cacheable.
  if (!entry) return { apiKey: null, fill: true };
  // A tombstone: this credential was revoked moments ago. Ask the database, and cache nothing.
  if (!('apiKey' in entry) || !entry.apiKey) return { apiKey: null, fill: false };

  const { apiKey } = entry;
  // Defence in depth: never trust an entry outside the cacheable set, nor one past its expiry.
  if (!isCacheableApiKey(apiKey) || !isLive(apiKey, now)) return { apiKey: null, fill: false };

  cacheHitCounter.inc({ cache_name: CACHE_NAME, cache_type: 'apiKeyPrincipal' });
  return { apiKey, fill: false };
}

/**
 * When a lookup began, read BEFORE its cache read: the wall clock, because the entry's absolute
 * expiry is enforced on Redis's wall clock.
 */
export type LookupStart = { startedAtWallMs: number };
export const startLookup = (): LookupStart => ({ startedAtWallMs: Date.now() });

/**
 * Cache a row the database just returned (after a cache miss), until `API_KEY_PRINCIPAL_TTL_SECONDS`
 * after its lookup began, or the key's `expiresAt` if sooner. The expiry is absolute; see the module
 * comment. Best-effort and never throws.
 */
export async function cacheApiKey(hash: string, apiKey: CachedApiKey, lookup: LookupStart) {
  if (!isCacheableApiKey(apiKey)) return;
  cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: 'apiKeyPrincipal' });
  let expireAtMs = lookup.startedAtWallMs + API_KEY_PRINCIPAL_TTL_SECONDS * 1000;
  if (apiKey.expiresAt !== null)
    expireAtMs = Math.min(expireAtMs, new Date(apiKey.expiresAt).getTime());
  // Already past (e.g. the key expired while its row was being read): nothing worth writing.
  if (expireAtMs <= Date.now()) return;
  try {
    // NX: a standing tombstone refuses a refill that read the row before the revoke.
    await redis.packed.set<Entry>(entryKey(hash), { apiKey }, { PXAT: expireAtMs, NX: true });
  } catch (error) {
    report(error, 'write');
  }
}

/**
 * Stop serving these credentials from the cache. Call it after the database write that revokes or
 * changes them has committed, with the `key` column (the hash) of every affected row.
 *
 * A plain SET, never NX: the tombstone must REPLACE a cached row.
 *
 * Never throws: the revoking write has already committed, and failing the request would not undo
 * it. A failure is reported and leaves the old entry for at most its TTL.
 */
export async function evictCachedApiKeys(hashes: string[]) {
  const unique = [...new Set(hashes.filter(Boolean))];
  if (!unique.length) return;
  const results = await Promise.allSettled(
    // Inside an async callback, so a client that throws synchronously rejects one promise rather
    // than escaping the whole call.
    unique.map(async (hash) =>
      redis.packed.set<Entry>(
        entryKey(hash),
        { revoked: true },
        { EX: API_KEY_TOMBSTONE_TTL_SECONDS }
      )
    )
  );
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length) report(failed[0].reason, `evict (${failed.length}/${unique.length} failed)`);
}

/**
 * Whether this request should write `lastUsedAt`. The column is shown to users with day precision
 * and has always been written at most about once an hour per key; with the row now cached it can be
 * up to a TTL stale, so the hour is also claimed in Redis so only one request writes it. When Redis is
 * unavailable this falls back to the old rule (the row's own `lastUsedAt` alone).
 */
export async function claimLastUsedWrite(
  apiKey: Pick<CachedApiKey, 'id' | 'lastUsedAt'>,
  now: Date
) {
  const last = apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).getTime() : null;
  if (last !== null && now.getTime() - last <= API_KEY_LAST_USED_DEBOUNCE_SECONDS * 1000)
    return false;
  try {
    const claimed = await redis.set(lastUsedKey(apiKey.id), '1', {
      NX: true,
      EX: API_KEY_LAST_USED_DEBOUNCE_SECONDS,
    });
    return claimed !== null;
  } catch {
    return true;
  }
}

/** Release a claim whose database write failed, so the next request retries it. */
export async function releaseLastUsedWrite(id: number) {
  await redis.del(lastUsedKey(id)).catch(() => undefined);
}
