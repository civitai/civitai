import type { SessionStateCaller } from '~/server/auth/session-metrics';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  ACCOUNT_STANDING_REBUST_MS,
  REDIS_KEYS,
  redis,
  type RedisKeyTemplateCache,
} from '~/server/redis/client';
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

export { ACCOUNT_STANDING_REBUST_MS };

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

/**
 * What the cache holds for an account: the three facts `assertAccountNotRestricted` refuses on.
 * `exists: false` is a missing row.
 */
export type AccountStanding = { muted: boolean; banned: boolean; exists: boolean };

async function readStanding(userId: number): Promise<AccountStanding> {
  // The primary: a miss is most likely right after a change, which the replica may not have yet.
  const row = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { muted: true, bannedAt: true },
  });
  if (!row) return { muted: false, banned: false, exists: false };
  return { muted: row.muted ?? false, banned: row.bannedAt != null, exists: true };
}

// One direct read per user per pod at a time: when the cache is down every guarded mutation lands
// here, and concurrent ones for the same account share the read.
const directReads = new Map<number, Promise<AccountStanding>>();
function readStandingShared(userId: number): Promise<AccountStanding> {
  const inFlight = directReads.get(userId);
  if (inFlight) return inFlight;
  const read = readStanding(userId).finally(() => directReads.delete(userId));
  directReads.set(userId, read);
  return read;
}

// The key once held a bare `muted` boolean, and a pod from before this shape may still write one
// (and reads only a boolean itself). Anything but the full object is a miss here, read directly.
function isStanding(value: unknown): value is AccountStanding {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.muted === 'boolean' && typeof v.banned === 'boolean' && typeof v.exists === 'boolean'
  );
}

/**
 * The account's stored standing, through the cache. Throws when neither the cache nor the database
 * answers: a caller deciding whether to refuse must not read a failure as "in good standing".
 */
export async function getAccountStanding(userId: number): Promise<AccountStanding> {
  try {
    const cached = await withTimeoutFallback<unknown>(
      fetchThroughCache(cacheKey(userId), () => readStandingShared(userId), {
        ttl: ACCOUNT_STANDING_TTL,
        retryCount: 0,
      }),
      ACCOUNT_STANDING_CACHE_DEADLINE_MS,
      CACHE_TIMED_OUT
    );
    if (isStanding(cached)) return cached;
  } catch {
    // A cold key whose refill another request holds, or an origin error: read directly below.
  }
  return readStandingShared(userId);
}

/**
 * Whether the account is muted now, for a caller holding a session that may be older than the
 * stored standing. Never throws: when neither the cache nor the database answers, returns
 * `sessionValue`, logged as `account-standing.cache-read-failed`.
 */
export async function isAccountMuted(userId: number, sessionValue: boolean): Promise<boolean> {
  try {
    return (await getAccountStanding(userId)).muted;
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

function startRevoke(userId: number) {
  // Not awaited: the orchestrator call has a 5 s timeout and runs inside job loops.
  // `revokeCivitaiUserTokens` logs its own failures.
  void Promise.resolve()
    .then(() => revokeCivitaiUserTokens({ userId }))
    .catch(() => false);
}

/**
 * Run after a ban or unban has committed: drops the cached standing now and again after
 * `ACCOUNT_STANDING_REBUST_MS`, past a refill that read the row before the write. The ban path takes
 * its own session and token steps. Never throws.
 */
export async function afterAccountBanChanged(userId: number): Promise<void> {
  await bustStanding(userId);
  setTimeout(() => void bustStanding(userId), ACCOUNT_STANDING_REBUST_MS).unref?.();
}

/** The session step the caller takes for this change; repeated here so the revoke can follow it. */
export type StandingSessionStep = { kind: 'refresh' | 'invalidate'; caller: SessionStateCaller };

/**
 * Run after a mute or unmute has committed: drops the cached standing, takes the caller's session
 * step, then revokes the orchestrator's cached tokens, and repeats all three after
 * `ACCOUNT_STANDING_REBUST_MS`. The revoke comes last because the orchestrator re-validates through
 * `/api/v1/me`, which reports the session's standing. Never throws; returns whether the session step
 * succeeded, for a caller that must report a failed one.
 */
export async function afterAccountStandingChanged(
  userId: number,
  session: StandingSessionStep
): Promise<boolean> {
  await bustStanding(userId);
  let sessionStepped = false;
  try {
    const { invalidateSession, refreshSession } = await import(
      '~/server/auth/session-invalidation'
    );
    if (session.kind === 'refresh') await refreshSession(userId, { caller: session.caller });
    else await invalidateSession(userId, session.caller);
    sessionStepped = true;
  } catch (error) {
    logStandingError('account-standing.session-step-failed', userId, error);
  } finally {
    startRevoke(userId);
  }
  await expireGenerationCredentialsIfMuted(userId);
  setTimeout(() => void repeatStandingChange(userId), ACCOUNT_STANDING_REBUST_MS).unref?.();
  return sessionStepped;
}

/** A mute also ends the generation credentials already issued, so none outlives it. Never throws. */
export async function expireGenerationCredentialsIfMuted(userId: number) {
  try {
    if (!(await readStanding(userId)).muted) return;
    const { expireGenerationCredentials } = await import('~/server/services/api-key.service');
    await expireGenerationCredentials(userId);
  } catch (error) {
    logStandingError('account-standing.generation-credentials-expire-failed', userId, error);
  }
}

async function repeatStandingChange(userId: number) {
  await bustStanding(userId);
  try {
    const { clearSessionCache } = await import('~/server/auth/session-cache');
    await clearSessionCache(userId);
  } catch (error) {
    logStandingError('account-standing.session-step-failed', userId, error);
  }
  // Again: a key minted between the first expire and the cache settling would otherwise outlive the mute.
  await expireGenerationCredentialsIfMuted(userId);
  startRevoke(userId);
}
