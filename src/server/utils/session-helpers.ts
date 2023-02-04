import { User } from '@prisma/client';
import { JWT } from 'next-auth/jwt';
import { prisma } from '~/server/db/client';
import { getSessionUser } from '~/server/services/user.service';
import { createLogger } from '~/utils/logging';

const log = createLogger('session-helpers', 'green');
declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var sessionsToInvalidate: Record<number, Date>;
  // eslint-disable-next-line no-var, vars-on-top
  var sessionsFetch: Promise<Record<number, Date>> | null;
}

async function getSessionsToInvalidate() {
  if (global.sessionsToInvalidate) return global.sessionsToInvalidate;
  if (global.sessionsFetch) return global.sessionsFetch;
  log('Fetching sessions to invalidate', global.sessionsFetch);
  global.sessionsFetch = prisma.sessionInvalidation
    .groupBy({
      by: ['userId'],
      _max: { invalidatedAt: true },
    })
    .then((x) => {
      const toInvalidate: typeof sessionsToInvalidate = {};
      for (const {
        userId,
        _max: { invalidatedAt },
      } of x) {
        toInvalidate[userId] = invalidatedAt ?? new Date();
      }
      global.sessionsToInvalidate = toInvalidate;
      log(`Fetched ${x.length} sessions to invalidate`);
      return global.sessionsToInvalidate;
    })
    .catch(() => {
      global.sessionsToInvalidate = {};
      log(`Failed to get sessions to invalidate`);
      return global.sessionsToInvalidate;
    });

  return global.sessionsFetch;
}

export async function refreshToken(token: JWT) {
  if (!token.user) return token;
  const user = token.user as User;
  if (!user.id) return token;
  const toInvalidate = await getSessionsToInvalidate();
  const invalidationDate = toInvalidate[user.id];
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
  sessionsToInvalidate[userId] = new Date();

  // Store in DB so that we can resume on reboot
  prisma.sessionInvalidation
    .createMany({
      data: { userId },
    })
    .then(() => {
      log(`Invalidated session for user ${userId}`);
    })
    .catch(() => {
      log(`Failed to invalidate session for user ${userId}`);
    });
}
