import { SignalMessages } from '~/server/common/enums';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
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
    await sysRedis.hSet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, userTokensObj);
    await sysRedis.hExpire(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, userTokens, DEFAULT_EXPIRATION);
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

export async function refreshSession(userId: number) {
  const userTokens = await updateSessionState(userId, 'refresh');
  await sendSessionSignal(userId, 'refresh');

  log(`Refreshed session for user ${userId} - ${userTokens.length} token(s) marked for refresh`);
}

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
