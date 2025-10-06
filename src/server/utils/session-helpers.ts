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

const TOKEN_ID_ENFORCEMENT = 1713139200000;

export async function invalidateToken(token: JWT) {
  if (!token?.id || typeof token.id !== 'string') return;

  await sysRedis.hSet(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, Date.now());
  // Refresh TTL on the hash to prevent unbounded growth
  // Note: The hourly cleanup job handles bulk cleanup, but TTL adds defense-in-depth
  await sysRedis.hExpire(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, DEFAULT_EXPIRATION);
  log(`Invalidated token ${token.id}`);
}

export async function refreshToken(token: JWT): Promise<JWT | null> {
  if (!token.user) return token;
  const user = token.user as User;

  // Return null only for explicit invalidations
  if (!!(user as any).clearedAt) return null;
  if (!user.id) return token;

  let shouldRefresh = false;

  // Enforce Token Validity
  if (!token.id) {
    if (Date.now() > TOKEN_ID_ENFORCEMENT) return null;
    shouldRefresh = true;
  } else {
    const tokenInvalid = await sysRedis.hExists(
      REDIS_SYS_KEYS.SESSION.INVALID_TOKENS,
      token.id as string
    );
    if (tokenInvalid) return null; // Explicit invalidation
  }

  // Enforce Token Refresh
  if (!shouldRefresh) {
    const userDateStr = await redis.get(`${REDIS_KEYS.SESSION.BASE}:${user.id}`);
    const userDate = userDateStr ? new Date(userDateStr) : undefined;
    const allInvalidationDateStr = await sysRedis.get(REDIS_SYS_KEYS.SESSION.ALL);
    const allInvalidationDate = allInvalidationDateStr
      ? new Date(allInvalidationDateStr)
      : undefined;
    const invalidationDate =
      userDate && allInvalidationDate
        ? new Date(Math.max(userDate.getTime(), allInvalidationDate.getTime()))
        : userDate ?? allInvalidationDate;

    if (!token.signedAt) {
      missingSignedAtCounter?.inc();
      shouldRefresh = true;
    } else if (invalidationDate && token.signedAt) {
      shouldRefresh = invalidationDate.getTime() > (token.signedAt as number);
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

  token.id = token.id ?? uuid();
  token.signedAt = Date.now();
}

export async function invalidateSession(userId: number) {
  await Promise.all([
    redis.set(`${REDIS_KEYS.SESSION.BASE}:${userId}`, new Date().toISOString(), {
      EX: DEFAULT_EXPIRATION, // 30 days
    }),
    redis.del(`${REDIS_KEYS.USER.SESSION}:${userId}`),
    redis.del(`${REDIS_KEYS.CACHES.MULTIPLIERS_FOR_USER}:${userId}`),
    redis.del(`${REDIS_KEYS.USER.SETTINGS}:${userId}`),
    invalidateCivitaiUser({ userId }), // Ensures the orch. user is also invalidated
  ]);
  log(`Scheduling refresh session for user ${userId}`);
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
