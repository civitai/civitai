import type { JWT } from 'next-auth/jwt';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { hSetWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { User } from '~/shared/utils/prisma/models';
import { createLogger } from '~/utils/logging';
import { clearSessionCache } from './session-cache';

const DEFAULT_EXPIRATION = 60 * 60 * 24 * 30; // 30 days
const log = createLogger('token-tracking', 'green');

export async function trackToken(tokenId: string, userId: number) {
  try {
    const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`;

    // Atomic single-EVAL set+TTL — closes the race window where a process
    // kill or sysRedis flap between the two awaits leaves a no-TTL field.
    await hSetWithTTL(
      sysRedis,
      key,
      tokenId,
      Date.now(),
      DEFAULT_EXPIRATION * 1000
    );

    log(`Tracked token ${tokenId} for user ${userId}`);
  } catch (error) {
    // Fail-open wrapper (PR #2332 round-4 audit fix): mirror the sibling
    // `invalidateToken` (round-3) so Loki/Grafana see the same structured
    // `sysredis-fail-open` event for the write-degraded sysRedis path
    // instead of a plain dev-style log line. Subtype `write-degraded`
    // matches session-invalidation.updateSessionState.
    logSysRedisFailOpen(
      'write-degraded',
      'token-tracking.trackToken',
      error,
      { tokenId, userId }
    );
  }
}

export async function invalidateToken(token: JWT) {
  if (!token?.id || typeof token.id !== 'string') return;

  // await sysRedis
  //   .multi()
  //   .hSet(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, 'invalid')
  //   .hExpire(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, DEFAULT_EXPIRATION)
  //   .exec();

  // Atomic single-EVAL set+TTL — closes the race window where a process kill
  // or sysRedis flap between the two awaits leaves a no-TTL field. Important
  // here because TOKEN_STATE='invalid' must reliably expire — if it sticks
  // forever a re-issued tokenId could be permanently rejected.
  //
  // Fail-open wrapper (PR #2332 round-3 audit fix): this function is
  // called from the next-auth `signOut` event handler, so an in-flight
  // EVAL throw during a sysRedis sentinel failover (Phase 4) would
  // otherwise propagate up into the callback chain and 500 the logout
  // request. The fail-open semantic matches the read side
  // (token-refresh.ts, refreshToken pipeline): during a sysRedis
  // outage we don't observe the `invalid` marker on the read path
  // anyway, so a missed write is symmetric — the active session simply
  // continues until next-auth's own JWT exp fires. Subtype
  // `write-degraded` mirrors session-invalidation.updateSessionState.
  try {
    await hSetWithTTL(
      sysRedis,
      REDIS_SYS_KEYS.SESSION.TOKEN_STATE,
      token.id,
      'invalid',
      DEFAULT_EXPIRATION * 1000
    );
  } catch (err) {
    logSysRedisFailOpen(
      'write-degraded',
      'token-tracking.invalidateToken',
      err,
      { tokenId: token.id }
    );
  }

  // Remove from user's token hash
  if (!token.user) return;
  const user = token.user as User;
  await Promise.all([
    sysRedis.hDel(`${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}` as any, token.id),
    clearSessionCache(user.id),
  ]);

  log(`Invalidated token ${token.id}`);
}
