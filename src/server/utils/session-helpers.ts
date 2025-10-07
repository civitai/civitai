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
    // await redis
    //   .multi()
    //   .sAdd(`${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`, tokenId)
    //   .expire(`${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`, DEFAULT_EXPIRATION)
    //   .exec();

    await Promise.all([
      redis.sAdd(`${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`, tokenId),
      redis.expire(`${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`, DEFAULT_EXPIRATION),
    ]);

    log(`Tracked token ${tokenId} for user ${userId}`);
  } catch (error) {
    log(`Error tracking token ${tokenId} for user ${userId}: ${(error as Error).message}`);
  }
}

export async function invalidateToken(token: JWT) {
  if (!token?.id || typeof token.id !== 'string') return;

  // await sysRedis
  //   .multi()
  //   .hSet(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, Date.now())
  //   .hExpire(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, DEFAULT_EXPIRATION)
  //   .exec();

  await Promise.all([
    sysRedis.hSet(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, Date.now()),
    sysRedis.hExpire(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, DEFAULT_EXPIRATION),
  ]);

  // Remove from user's token set
  if (!token.user) return;
  const user = token.user as User;
  await redis.sRem(`${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}`, token.id);

  log(`Invalidated token ${token.id}`);
}

export async function refreshToken(token: JWT): Promise<JWT | null> {
  if (!token.user) return token;
  const user = token.user as User;

  // Return null only for explicit invalidations
  if (!!(user as any).clearedAt) return null;
  if (!user.id) return token;

  // Enforce token ID requirement
  if (!token.id) return null;

  let shouldRefresh = false;

  if (!token.signedAt) {
    shouldRefresh = true;
  }

  if (!shouldRefresh) {
    const tokenId = token.id as string;

    // Check if token is invalid BEFORE tracking it
    const tokenInvalid = await sysRedis.hExists(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, tokenId);
    if (tokenInvalid) {
      await sysRedis.hDel(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, tokenId);
      return null; // Explicit invalidation
    }

    // Check if token is tracked (migration for pre-existing sessions)
    const isTracked = await redis.sIsMember(
      `${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}`,
      tokenId
    );
    if (!isTracked) {
      // Force refresh for untracked tokens to ensure they get properly tracked
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

function setToken(token: JWT, session: AsyncReturnType<typeof getSessionUser>) {
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
    // redis
    //   .multi()
    //   .sAdd(`${REDIS_KEYS.SESSION.USER_TOKENS}:${session.id}`, tokenId)
    //   .expire(`${REDIS_KEYS.SESSION.USER_TOKENS}:${session.id}`, DEFAULT_EXPIRATION)
    //   .exec()
    //   .catch((error) => {
    //     log(`Error tracking token ${tokenId} for user ${session.id}: ${error.message as string}`);
    //   });

    Promise.all([
      redis.sAdd(`${REDIS_KEYS.SESSION.USER_TOKENS}:${session.id}`, tokenId),
      redis.expire(`${REDIS_KEYS.SESSION.USER_TOKENS}:${session.id}`, DEFAULT_EXPIRATION),
    ]).catch((error) => {
      log(`Error tracking token ${tokenId} for user ${session.id}: ${error.message as string}`);
    });
  }
}

export async function invalidateSession(userId: number) {
  // Get all tokens for this user and invalidate them
  const userTokens = await redis.sMembers(`${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`);

  const now = Date.now();

  const userTokensObj = userTokens.reduce<Record<string, number>>(
    (acc, token) => ({ ...acc, [token]: now }),
    {}
  );
  console.log({ userTokensObj });

  await Promise.all([
    redis.del(`${REDIS_KEYS.USER.SESSION}:${userId}`),
    redis.del(`${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:${userId}`),
    redis.del(`${REDIS_KEYS.USER.SETTINGS}:${userId}`),
    redis.del(`${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`), // Clean up token set
    // Invalidate all user tokens
    // sysRedis
    //   .multi()
    //   .hSet(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, userTokensObj)
    //   .hExpire(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, userTokens, DEFAULT_EXPIRATION)
    //   .exec(),
    sysRedis.hSet(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, userTokensObj),
    sysRedis.hExpire(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, userTokens, DEFAULT_EXPIRATION),
    // Ensures the orch. user is also invalidated
    invalidateCivitaiUser({ userId }),
  ]);

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
