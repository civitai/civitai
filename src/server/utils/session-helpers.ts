import { User } from '@prisma/client';
import { JWT } from 'next-auth/jwt';
import { getSessionUser } from '~/server/services/user.service';
import { createLogger } from '~/utils/logging';
import { redis } from '~/server/redis/client';

const log = createLogger('session-helpers', 'green');
declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var sessionsToInvalidate: Record<number, Date>;
  // eslint-disable-next-line no-var, vars-on-top
  var sessionsFetch: Promise<Record<number, Date>> | null;
}

export async function refreshToken(token: JWT) {
  if (!token.user) return token;
  const user = token.user as User;
  if (!user.id) return token;
  const redisDate = await redis.get(`session:${user.id}`);
  const invalidationDate = redisDate ? new Date(redisDate) : undefined;
  if (
    !invalidationDate ||
    (token.signedAt && new Date(token.signedAt as string) > invalidationDate)
  )
    return token;

  const refreshedUser = await getSessionUser({ userId: user.id });
  if (!refreshedUser) token.user = undefined;
  else {
    token.user = refreshedUser;
    token.signedAt = new Date();
  }
  log(`Refreshed session for user ${user.id}`);

  return token;
}

export function invalidateSession(userId: number) {
  redis.set(`session:${userId}`, new Date().toISOString(), {
    EX: 60 * 60 * 24 * 30, // 30 days
  });
}
