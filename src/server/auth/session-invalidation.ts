import { SignalMessages } from '~/server/common/enums';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { hSetMultiWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { clearCacheByPattern } from '~/server/utils/cache-helpers';
import { createLogger } from '~/utils/logging';
import { signalClient } from '~/utils/signal-client';
import { clearSessionCache } from './session-cache';

const DEFAULT_EXPIRATION = 60 * 60 * 24 * 30; // 30 days
const log = createLogger('session-invalidation', 'green');

async function updateSessionState(userId: number, type: 'refresh' | 'invalid') {
  const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`;

  // Get all tokens from hash (expired fields are automatically removed by Redis)
  const tokenHash = await sysRedis.hGetAll(key as any);
  const userTokens = Object.keys(tokenHash);
  const userTokensObj = userTokens.reduce<Record<string, string>>(
    (acc, token) => ({ ...acc, [token]: type }),
    {}
  );

  await clearSessionCache(userId);
  if (Object.keys(userTokensObj).length > 0) {
    // Atomic multi-field set+TTL — single EVAL replaces the sequential
    // hSet (multi-field) + hExpire (multi-field). The previous pair could
    // leave a subset of fields no-TTL if the second call failed; here all
    // fields land with the same DEFAULT_EXPIRATION TTL atomically.
    //
    // Fail-open wrapper: an in-flight EVAL throw during a sysRedis
    // sentinel failover (Phase 4) would otherwise propagate up into the
    // next-auth `update` callback chain (refreshSession → here) and 500
    // the user-facing request. Match the pattern from PR #2286 / the
    // setToken helper in token-refresh.ts. The throw class we tolerate
    // here is sysRedis unreachability; the trade-off is documented on
    // invalidateSession below (read path in token-refresh.ts is already
    // fail-open, so the unobserved write is symmetric).
    try {
      await hSetMultiWithTTL(
        sysRedis,
        REDIS_SYS_KEYS.SESSION.TOKEN_STATE,
        userTokensObj,
        DEFAULT_EXPIRATION * 1000
      );
    } catch (err) {
      logSysRedisFailOpen(
        'write-degraded',
        'session-invalidation.updateSessionState',
        err,
        { userId, type, tokenCount: userTokens.length }
      );
    }
  }
  return userTokens;
}

async function sendSessionSignal(userId: number, type: 'refresh' | 'invalid') {
  try {
    await signalClient.send({
      userId,
      target: SignalMessages.SessionRefresh,
      data: { type },
    });
  } catch (error) {
    // Don't let signal failures break session invalidation
    log(`Failed to send session ${type} signal to user ${userId}: ${error}`);
  }
}

export async function refreshSession(userId: number, { sendSignal = true } = {}) {
  const userTokens = await updateSessionState(userId, 'refresh');
  if (sendSignal) {
    await sendSessionSignal(userId, 'refresh');
  }

  log(`Refreshed session for user ${userId} - ${userTokens.length} token(s) marked for refresh`);
}

/**
 * Mark a user's tokens as invalid in sysRedis and signal active sessions
 * to log out.
 *
 * SECURITY/IR NOTE: this path is fail-open on sysRedis unreachability
 * (PR #2332 round-3 audit fix). The write swallows the error and emits
 * a `sysredis-fail-open` Loki/Axiom event with subtype `write-degraded`
 * — see `updateSessionState` above. During a sysRedis outage the
 * invalidation does NOT take effect; callers that need guaranteed
 * invalidation (stolen-token reports, account-takeover response) MUST
 * retry after sysRedis recovery. This is symmetric with the read path:
 * the refreshToken pipeline in token-refresh.ts is already fail-open on
 * read errors, so `tokenState === 'invalid'` is never observed during
 * the outage window even if a prior successful call wrote it — the
 * read itself fails open and the session continues. Throwing here would
 * not have prevented the session from staying alive; it would only have
 * 500'd the user-facing request that triggered the invalidation.
 */
export async function invalidateSession(userId: number) {
  const userTokens = await updateSessionState(userId, 'invalid');
  await sendSessionSignal(userId, 'invalid');

  log(`Invalidated session for user ${userId} and ${userTokens.length} token(s)`);
}

export async function invalidateAllSessions(asOf: Date | undefined = new Date()) {
  await sysRedis.set(REDIS_SYS_KEYS.SESSION.ALL, asOf.toISOString(), {
    EX: DEFAULT_EXPIRATION, // 30 days
  });
  await clearCacheByPattern(`${REDIS_KEYS.USER.SESSION}:*`);
  log(`Scheduling session refresh for all users`);
}
