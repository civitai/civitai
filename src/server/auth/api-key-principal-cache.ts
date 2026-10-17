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
 *   - EVERY ENTRY EXPIRES WITHIN `API_KEY_PRINCIPAL_TTL_SECONDS` OF THE LOOKUP THAT PRODUCED IT, not of
 *     the write: the write's TTL is what is left of that budget, so a slow refill is cached for less.
 *     That is what makes the residual window below true from the lookup start.
 *   - REVOCATION WRITES A TOMBSTONE rather than deleting the entry, and refills use SET NX. While the
 *     tombstone stands every request goes to the database, and a refill cannot land on top of it.
 *     A refill whose read began before the revoke must therefore REACH Redis before the tombstone
 *     expires. Two bounds give that:
 *       1. a refill is not ISSUED once more than `API_KEY_MAX_REFILL_AGE_SECONDS` have passed since
 *          its lookup began (monotonic clock), so a stalled database read cannot issue one late;
 *       2. the bound in (1) is on issue time, not arrival: the cache client queues commands while a
 *          shard reconnects, so an issued SET can arrive much later. The tombstone is therefore
 *          long (`API_KEY_TOMBSTONE_TTL_SECONDS`, 15 min) — tombstones are tiny and exist only for
 *          revoked keys — so a queued refill arriving inside it is still refused.
 *     What is left: a Redis connection that stays down, with the refill queued, for longer than the
 *     tombstone TTL.
 *   - ONLY `User` and `System` keys with no OAuth client are cached. OAuth access tokens bypass the
 *     cache entirely: they are revoked from more places (including another service writing the table
 *     directly) and their request path reads the consent row anyway.
 *
 * Residual window, at most `API_KEY_PRINCIPAL_TTL_SECONDS` from the lookup that cached the row: a
 * revocation whose tombstone write fails
 * (Redis unavailable at that moment), and any change made to the table without going through
 * `evictCachedApiKeys` — manual SQL, another service — leave a cached row in place until it expires.
 * Every write site in this repo is pinned by `api-key-principal-cache.ledger.test.ts`.
 */
export const API_KEY_PRINCIPAL_TTL_SECONDS = 30;
// A refill older than this (measured from before its cache read) is not written. A healthy
// single-row primary read takes milliseconds; skipping the write only costs a later miss.
export const API_KEY_MAX_REFILL_AGE_SECONDS = 10;
// Must outlive the ARRIVAL of every refill that could have been issued before the revoke, including
// one queued in the client during a reconnect (see the module comment).
export const API_KEY_TOMBSTONE_TTL_SECONDS = 15 * 60;
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

  if (!entry) {
    cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: 'apiKeyPrincipal' });
    return { apiKey: null, fill: true };
  }
  // A tombstone: this credential was revoked moments ago. Ask the database, and cache nothing.
  if (!('apiKey' in entry) || !entry.apiKey) return { apiKey: null, fill: false };

  const { apiKey } = entry;
  // Defence in depth: never trust an entry outside the cacheable set, nor one past its expiry.
  if (!isCacheableApiKey(apiKey) || !isLive(apiKey, now)) return { apiKey: null, fill: false };

  cacheHitCounter.inc({ cache_name: CACHE_NAME, cache_type: 'apiKeyPrincipal' });
  return { apiKey, fill: false };
}

/** When a lookup began, read BEFORE its cache read. `startedAt` is `performance.now()`. */
export type LookupStart = { startedAt: number };
export const startLookup = (): LookupStart => ({ startedAt: performance.now() });

/**
 * Cache a row the database just returned, for what is left of the lookup's TTL budget. A refill
 * older than `API_KEY_MAX_REFILL_AGE_SECONDS` is not written (see the module comment). Ages are
 * measured on the monotonic clock, so a wall-clock step back cannot make a lookup look younger.
 * Best-effort and never throws.
 */
export async function cacheApiKey(hash: string, apiKey: CachedApiKey, lookup: LookupStart) {
  if (!isCacheableApiKey(apiKey)) return;
  const ageMs = performance.now() - lookup.startedAt;
  if (ageMs > API_KEY_MAX_REFILL_AGE_SECONDS * 1000) return;
  let ttl = Math.floor((API_KEY_PRINCIPAL_TTL_SECONDS * 1000 - ageMs) / 1000);
  if (apiKey.expiresAt !== null) {
    // Against the wall clock at write time: `expiresAt` is a wall-clock instant.
    const remaining = Math.floor((new Date(apiKey.expiresAt).getTime() - Date.now()) / 1000);
    ttl = Math.min(ttl, remaining);
  }
  if (ttl <= 0) return;
  try {
    // NX: a tombstone written by a revoke wins over a refill that started before it.
    await redis.packed.set<Entry>(entryKey(hash), { apiKey }, { EX: ttl, NX: true });
  } catch (error) {
    report(error, 'write');
  }
}

/**
 * Stop serving these credentials from the cache. Call it after the database write that revokes or
 * changes them has committed, with the `key` column (the hash) of every affected row.
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
