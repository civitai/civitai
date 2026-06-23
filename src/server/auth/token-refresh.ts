import type { JWT } from 'next-auth/jwt';
import { v4 as uuid } from 'uuid';
import {
  REDIS_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { hSetWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { getSessionUser } from './session-user';
import type { User } from '~/shared/utils/prisma/models';
import { createLogger } from '~/utils/logging';

const DEFAULT_EXPIRATION = 60 * 60 * 24 * 30; // 30 days
const log = createLogger('token-refresh', 'green');

export type RefreshTokenResult = {
  token: JWT | null;
  /** True when session was refreshed or invalidated (client should update its cookie) */
  needsCookieRefresh: boolean;
};

/**
 * Clear the refresh marker for a specific token.
 * Call this after the JWT cookie has been successfully updated (i.e., in JWT callback with trigger='update')
 *
 * Best-effort: a sysRedis write failure here just means the marker
 * sticks around (the next refreshToken pipeline will surface it as
 * tokenState === 'refresh' again, signaling another cookie refresh).
 * Throwing would 500 the JWT update callback during a sysRedis blip.
 */
export async function clearTokenRefreshMarker(tokenId: string) {
  try {
    await sysRedis.hDel(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, tokenId);
    log(`Cleared refresh marker for token ${tokenId}`);
  } catch (err) {
    logSysRedisFailOpen('write-degraded', 'clearTokenRefreshMarker', err, { tokenId });
  }
}

export async function refreshToken(token: JWT): Promise<RefreshTokenResult> {
  if (!token.user) return { token: null, needsCookieRefresh: false };
  const user = token.user as User;

  // Return null only for explicit invalidations
  if (!!(user as any).clearedAt) return { token: null, needsCookieRefresh: false };
  if (!user.id) return { token: null, needsCookieRefresh: false };

  // Enforce token ID requirement
  if (!token.id) return { token: null, needsCookieRefresh: false };

  const tokenId = token.id as string;
  const userTokenKey = `${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}`;

  // Use Redis pipeline to batch all read operations into a single round trip
  // This reduces network latency from 3 sequential calls to 1 call.
  // If sysRedis is unreachable, fail open: keep the existing session rather
  // than 500ing every authenticated request.
  let results;
  try {
    const pipeline = sysRedis.multi();
    pipeline.hGet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, tokenId); // [0] Check token state
    pipeline.hExists(userTokenKey as any, tokenId); // [1] Check if token exists in tracking
    pipeline.get(REDIS_SYS_KEYS.SESSION.ALL); // [2] Check global invalidation date
    // Wall-clock guard: a silent sysRedis half-open would otherwise park this exec()
    // for minutes (OS-keepalive teardown) on every authenticated request — no per-cmd
    // timeout on pipelines, no socketTimeout on the sys client. On timeout this throws
    // → fail open below.
    results = await withSysReadDeadline(pipeline.exec());
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'refreshToken pipeline', err, {
      userId: user.id,
      tokenId,
    });
    return { token, needsCookieRefresh: false };
  }

  // Handle pipeline errors (null result is distinct from a throw)
  if (!results) {
    log(`Pipeline failed for token ${tokenId}, allowing session to continue`);
    return { token, needsCookieRefresh: false };
  }

  // Extract results (multi().exec() in node-redis returns array of results directly)
  const tokenState = results[0] as unknown as string | null;
  const exists = results[1] as unknown as number;
  const allInvalidationDateStr = results[2] as unknown as string | null;

  // Handle explicit invalidation
  if (tokenState === 'invalid') {
    // Remove the user token tracking since it's invalid. Best-effort: if
    // sysRedis is mid-flap (read returned, write fails), still emit the
    // needsCookieRefresh signal — the TOKEN_STATE='invalid' record already
    // gates this token, so the tracking-hash delete is a cleanup, not a
    // correctness requirement.
    await sysRedis.hDel(userTokenKey as any, tokenId).catch((err) => {
      logSysRedisFailOpen('write-degraded', 'refreshToken hDel (invalid branch)', err, {
        userId: user.id,
        tokenId,
      });
    });
    // Keep the 'invalid' state in TOKEN_STATE - it will expire naturally after 30 days
    // This ensures subsequent requests with the same token continue to be rejected
    // Signal client to refresh cookie - when it does, it will get empty session and be logged out
    console.warn(
      `[refreshToken] needsCookieRefresh=true reason=invalid userId=${user.id} tokenId=${tokenId}`
    );
    return { token: null, needsCookieRefresh: true };
  }

  // Determine if token should be refreshed
  let shouldRefresh = false;
  let needsCookieRefresh = false;

  if (!token.signedAt) {
    shouldRefresh = true;
  }

  // Handle refresh marker - this means client's cookie is stale and needs updating
  // Note: We DON'T delete the marker here. It persists until the client calls update()
  // and the JWT callback runs with trigger='update', which actually updates the cookie.
  if (tokenState === 'refresh') {
    shouldRefresh = true;
    needsCookieRefresh = true; // Signal that client should refresh their session cookie
    log(`Token ${tokenId} marked for refresh for user ${user.id}`);
    console.warn(
      `[refreshToken] needsCookieRefresh=true reason=token-state-refresh userId=${user.id} tokenId=${tokenId}`
    );
  }

  // Check if token exists in tracking hash
  if (!shouldRefresh && !exists) {
    // Token not found - force refresh to track it
    shouldRefresh = true;
    log(`Found untracked token ${tokenId} for user ${user.id}, forcing refresh`);
  }

  // Check if all sessions should be refreshed
  if (!shouldRefresh && allInvalidationDateStr) {
    const allInvalidationDate = new Date(allInvalidationDateStr);
    if (allInvalidationDate.getTime() > (token.signedAt as number)) {
      shouldRefresh = true;
      needsCookieRefresh = true; // Global refresh also means cookies are stale
      console.warn(
        `[refreshToken] needsCookieRefresh=true reason=session-all userId=${user.id} tokenId=${tokenId} asOf=${allInvalidationDateStr} signedAt=${new Date(token.signedAt as number).toISOString()}`
      );
    }
  }

  if (!shouldRefresh) return { token, needsCookieRefresh: false };

  const refreshedUser = await getSessionUser({ userId: user.id });

  // Graceful degradation: if refresh fails, keep existing session
  if (!refreshedUser) {
    log(`Session refresh failed for user ${user.id}, keeping existing session`);
    return { token, needsCookieRefresh: false }; // Return existing token instead of setting user=undefined
  }

  setToken(token, refreshedUser);
  log(`Refreshed session for user ${user.id}`);

  return { token, needsCookieRefresh };
}

async function setToken(token: JWT, session: AsyncReturnType<typeof getSessionUser>) {
  if (!session) {
    token.user = undefined;
    return;
  }

  // Prepare token
  token.user = session;
  const _user = token.user as any;
  for (const key of Object.keys(_user)) {
    if (_user[key] instanceof Date) _user[key] = _user[key].toISOString();
    else if (typeof _user[key] === 'undefined') delete _user[key];
  }

  const tokenId = (token.id as string | undefined) ?? uuid();
  token.id = tokenId;
  token.signedAt = Date.now();

  // Track this token for the user. Best-effort: a sysRedis write failure
  // here would lose the refresh work above and 500 the request — degrade
  // to "refreshed in memory, tracking will catch up on next successful
  // call" instead.
  //
  // Known perf cliff: during a partial sysRedis outage (reads succeed,
  // writes fail), the next refreshToken pipeline sees `exists` return
  // 0 and forces shouldRefresh=true. That triggers a fresh
  // getSessionUser call. getSessionUser checks the regular-redis cache
  // FIRST (session-user.ts:36) — on a partial flap, that cache is
  // still being written normally, so most calls hit cache and skip DB.
  //
  // The DB amplification actually kicks in on a FULL sysRedis outage:
  // session-user.ts permissionsSourceDegraded skips the regular-redis
  // cache write, so every re-derivation cache-misses and goes to DB.
  // Then this setToken catch fires (because sysRedis writes also fail),
  // so each subsequent authed request repeats the cycle. The cliff is
  // real but conditioned on the full-outage case, not partial flaps.
  //
  // Known accumulation pattern: if hSet succeeds and hExpire fails, the
  // tokenId field on USER_TOKENS:userId persists without TTL. It's only
  // cleaned up by the explicit hDel in the tokenState === 'invalid'
  // branch above or a full session invalidation. After sustained
  // partial-flap windows, per-user USER_TOKENS hashes can accumulate
  // orphaned entries. Bounded per user but non-trivial in aggregate.
  // Same atomic-set+expire fix tracked for HA cutover.
  if (session.id) {
    const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${session.id}`;
    try {
      // Atomic single-EVAL set+TTL — closes the orphaned-entry accumulation
      // window described above (hSet succeeds, hExpire fails → no-TTL field
      // sticks around until the next explicit hDel / full invalidation).
      await hSetWithTTL(
        sysRedis,
        key,
        tokenId,
        Date.now(),
        DEFAULT_EXPIRATION * 1000
      );
    } catch (err) {
      logSysRedisFailOpen('tracking-write-cliff', 'setToken', err, {
        userId: session.id,
        tokenId,
      });
    }
  }
}
