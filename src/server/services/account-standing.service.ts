import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_KEYS, redis, type RedisKeyTemplateCache } from '~/server/redis/client';
import { revokeCivitaiUserTokens } from '~/server/services/orchestrator/civitai';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

/**
 * How long a cached standing is served as fresh. A change is seen at once through the bust in
 * `afterAccountStandingChanged`; when that bust is lost, an entry can be served for up to twice this,
 * since `fetchThroughCache` keeps entries for 2×TTL and hands an old one to a reader that loses the
 * refill lock.
 */
export const ACCOUNT_STANDING_TTL = CacheTTL.xs;

/**
 * How long a guarded mutation waits on the cache before reading the row directly. The guard is on
 * nearly every mutation, so a stalled cache must not hold them all for the Redis socket timeout.
 */
export const ACCOUNT_STANDING_CACHE_DEADLINE_MS = 300;
const CACHE_TIMED_OUT = Symbol('account-standing-cache-timed-out');

/**
 * A refill that read the row before the change committed can write the old standing after the first
 * bust. The second bust lands after any such refill: its lock expires after 10 s.
 */
export const ACCOUNT_STANDING_REBUST_MS = 11_000;

function logStandingError(name: string, userId: number, error?: unknown) {
  // Never throws, whatever `logToAxiom` returns.
  Promise.resolve()
    .then(() =>
      logToAxiom({ type: 'error', name, userId, ...(error ? { error: safeError(error) } : {}) })
    )
    .catch(() => null);
}

const cacheKey = (userId: number) =>
  `${REDIS_KEYS.CACHES.ACCOUNT_STANDING}:${userId}` as RedisKeyTemplateCache;

async function readMuted(userId: number): Promise<boolean> {
  // The primary: a miss is most likely right after a change, which the replica may not have yet.
  const row = await dbWrite.user.findUnique({ where: { id: userId }, select: { muted: true } });
  return row?.muted ?? false;
}

// One direct read per user per pod at a time: when the cache is down every guarded mutation lands
// here, and concurrent ones for the same account share the read.
const directReads = new Map<number, Promise<boolean>>();
function readMutedShared(userId: number): Promise<boolean> {
  const inFlight = directReads.get(userId);
  if (inFlight) return inFlight;
  const read = readMuted(userId).finally(() => directReads.delete(userId));
  directReads.set(userId, read);
  return read;
}

/**
 * Whether the account is muted now, for a caller holding a session that may be older than the
 * stored standing. Never throws: when neither the cache nor the database answers, returns
 * `sessionValue`, logged as `account-standing.cache-read-failed`.
 */
export async function isAccountMuted(userId: number, sessionValue: boolean): Promise<boolean> {
  try {
    const cached = await withTimeoutFallback<boolean | typeof CACHE_TIMED_OUT>(
      fetchThroughCache(cacheKey(userId), () => readMutedShared(userId), {
        ttl: ACCOUNT_STANDING_TTL,
        retryCount: 0,
      }),
      ACCOUNT_STANDING_CACHE_DEADLINE_MS,
      CACHE_TIMED_OUT
    );
    if (typeof cached === 'boolean') return cached;
  } catch {
    // A cold key whose refill another request holds, or an origin error: read directly below.
  }
  try {
    return await readMutedShared(userId);
  } catch (error) {
    logStandingError('account-standing.cache-read-failed', userId, error);
    return sessionValue;
  }
}

async function bustStanding(userId: number) {
  try {
    await redis.del(cacheKey(userId));
  } catch (error) {
    logStandingError('account-standing.cache-bust-failed', userId, error);
  }
}

/**
 * Run after a mute or unmute has committed, before anything else that can fail. Drops the cached
 * standing so `guardedProcedure` sees the change on the next request, and starts the orchestrator's
 * re-validation of the account's cached tokens without waiting on it (`revokeCivitaiUserTokens` logs
 * its own failures). Never throws.
 */
export async function afterAccountStandingChanged(userId: number): Promise<void> {
  void Promise.resolve()
    .then(() => revokeCivitaiUserTokens({ userId }))
    .catch(() => false);
  await bustStanding(userId);
  setTimeout(() => void bustStanding(userId), ACCOUNT_STANDING_REBUST_MS).unref?.();
}
