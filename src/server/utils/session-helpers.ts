import type { Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { v4 as uuid } from 'uuid';
import { missingSignedAtCounter } from '~/server/prom/client';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { invalidateCivitaiUser } from '~/server/services/orchestrator/civitai';
import { getSessionUser } from '~/server/services/user.service';
import { clearCacheByPattern } from '~/server/utils/cache-helpers';
import { generateSecretHash } from '~/server/utils/key-generator';
import type { User } from '~/shared/utils/prisma/models';
import { createLogger } from '~/utils/logging';

const DEFAULT_EXPIRATION = 60 * 60 * 24 * 30; // 30 days
const log = createLogger('session-helpers', 'green');
declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var sessionsToInvalidate: Record<number, Date>;
  // eslint-disable-next-line no-var, vars-on-top
  var sessionsFetch: Promise<Record<number, Date>> | null;
}

export async function trackToken(tokenId: string, userId: number) {
  try {
    const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`;

    // Use sysRedis which supports hExpire for individual field TTL
    await sysRedis.hSet(key as any, tokenId, Date.now());
    await sysRedis.hExpire(key as any, tokenId, DEFAULT_EXPIRATION);

    log(`Tracked token ${tokenId} for user ${userId}`);
  } catch (error) {
    log(`Error tracking token ${tokenId} for user ${userId}: ${(error as Error).message}`);
  }
}

export async function invalidateToken(token: JWT) {
  if (!token?.id || typeof token.id !== 'string') return;

  // await sysRedis
  //   .multi()
  //   .hSet(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, 'invalid')
  //   .hExpire(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, DEFAULT_EXPIRATION)
  //   .exec();

  await sysRedis.hSet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, token.id, 'invalid');
  await sysRedis.hExpire(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, token.id, DEFAULT_EXPIRATION);

  // Remove from user's token hash
  if (!token.user) return;
  const user = token.user as User;
  await Promise.all([
    sysRedis.hDel(`${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}` as any, token.id),
    clearSessionCache(user.id),
  ]);

  log(`Invalidated token ${token.id}`);
}

export async function refreshToken(token: JWT): Promise<JWT | null> {
  if (!token.user) return null;
  const user = token.user as User;

  // Return null only for explicit invalidations
  if (!!(user as any).clearedAt) return null;
  if (!user.id) return null;

  // Enforce token ID requirement
  if (!token.id) return null;

  let shouldRefresh = false;

  if (!token.signedAt) {
    shouldRefresh = true;
  }

  const tokenId = token.id as string;

  // Check token state in INVALID_TOKENS hash (single Redis call)
  const tokenState = await sysRedis.hGet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, tokenId);
  if (tokenState === 'invalid') {
    // Remove the user token tracking since it's invalid
    await sysRedis.hDel(`${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}` as any, tokenId);
    return null; // Explicit invalidation - force logout
  } else if (tokenState === 'refresh') {
    shouldRefresh = true;
    // Remove from hash after detecting it so it only refreshes once
    await sysRedis.hDel(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, tokenId);
    log(`Token ${tokenId} marked for refresh for user ${user.id}`);
  }

  if (!shouldRefresh) {
    const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}`;

    // Check if token exists in hash (expired tokens are automatically removed by Redis)
    const exists = await sysRedis.hExists(key as any, tokenId);
    if (!exists) {
      // Token not found - force refresh to track it
      shouldRefresh = true;
      log(`Found untracked token ${tokenId} for user ${user.id}, forcing refresh`);
    }
  }

  // Check if all sessions should be refreshed
  if (!shouldRefresh) {
    const allInvalidationDateStr = await sysRedis.get(REDIS_SYS_KEYS.SESSION.ALL);
    if (allInvalidationDateStr) {
      const allInvalidationDate = new Date(allInvalidationDateStr);
      if (allInvalidationDate.getTime() > (token.signedAt as number)) {
        shouldRefresh = true;
      }
    }
  }

  if (!shouldRefresh) return token;

  const refreshedUser = await getSessionUser({ userId: user.id });

  // Graceful degradation: if refresh fails, keep existing session
  if (!refreshedUser) {
    log(`Session refresh failed for user ${user.id}, keeping existing session`);
    return token; // Return existing token instead of setting user=undefined
  }

  setToken(token, refreshedUser);
  log(`Refreshed session for user ${user.id}`);

  return token;
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

async function clearSessionCache(userId: number) {
  await Promise.all([
    redis.del(`${REDIS_KEYS.USER.SESSION}:${userId}`),
    redis.del(`${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:${userId}`),
    redis.del(`${REDIS_KEYS.USER.SETTINGS}:${userId}`),
    invalidateCivitaiUser({ userId }),
  ]);
}

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
    await sysRedis.hSet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, userTokensObj);
    await sysRedis.hExpire(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, userTokens, DEFAULT_EXPIRATION);
  }
  return userTokens;
}

export async function refreshSession(userId: number) {
  const userTokens = await updateSessionState(userId, 'refresh');

  log(`Refreshed session for user ${userId} - ${userTokens.length} token(s) marked for refresh`);
}

export async function invalidateSession(userId: number) {
  const userTokens = await updateSessionState(userId, 'invalid');

  log(`Invalidated session for user ${userId} and ${userTokens.length} token(s)`);
}

export async function invalidateAllSessions(asOf: Date | undefined = new Date()) {
  await sysRedis.set(REDIS_SYS_KEYS.SESSION.ALL, asOf.toISOString(), {
    EX: DEFAULT_EXPIRATION, // 30 days
  });
  await clearCacheByPattern(`${REDIS_KEYS.USER.SESSION}:*`);
  log(`Scheduling session refresh for all users`);
}

export async function getSessionFromBearerToken(key: string) {
  const token = generateSecretHash(key.trim());
  const user = (await getSessionUser({ token })) as Session['user'];
  if (!user) return null;
  return { user } as Session;
}
