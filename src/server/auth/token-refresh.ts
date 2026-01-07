import type { JWT } from 'next-auth/jwt';
import { v4 as uuid } from 'uuid';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
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
  // This reduces network latency from 3 sequential calls to 1 call
  const pipeline = sysRedis.multi();
  pipeline.hGet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, tokenId); // [0] Check token state
  pipeline.hExists(userTokenKey as any, tokenId); // [1] Check if token exists in tracking
  pipeline.get(REDIS_SYS_KEYS.SESSION.ALL); // [2] Check global invalidation date

  const results = await pipeline.exec();

  // Handle pipeline errors
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
    // Remove the user token tracking since it's invalid
    await sysRedis.hDel(userTokenKey as any, tokenId);
    // Keep the 'invalid' state in TOKEN_STATE - it will expire naturally after 30 days
    // This ensures subsequent requests with the same token continue to be rejected
    // Signal client to refresh cookie - when it does, it will get empty session and be logged out
    return { token: null, needsCookieRefresh: true };
  }

  // Determine if token should be refreshed
  let shouldRefresh = false;
  let needsCookieRefresh = false;

  if (!token.signedAt) {
    shouldRefresh = true;
  }

  // Handle refresh marker - this means client's cookie is stale and needs updating
  if (tokenState === 'refresh') {
    shouldRefresh = true;
    needsCookieRefresh = true; // Signal that client should refresh their session cookie
    // Remove from hash after detecting it so it only refreshes once
    await sysRedis.hDel(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, tokenId);
    log(`Token ${tokenId} marked for refresh for user ${user.id}`);
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

  // Track this token for the user
  if (session.id) {
    const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${session.id}`;
    await sysRedis.hSet(key as any, tokenId, Date.now());
    await sysRedis.hExpire(key as any, tokenId, DEFAULT_EXPIRATION);
  }
}
