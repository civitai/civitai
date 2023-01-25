import { User } from '@prisma/client';
import { JWT } from 'next-auth/jwt';
import { prisma } from '~/server/db/client';

const SHOW_LOGS = false;
const log = (...args: any[]) => { //eslint-disable-line
  if (SHOW_LOGS) console.log('[session-helpers]', ...args);
};

let sessionsToInvalidate: Record<number, Date>;
let sessionsFetch: Promise<Record<number, Date>> | null = null;
async function getSessionsToInvalidate() {
  if (sessionsToInvalidate) return sessionsToInvalidate;
  if (sessionsFetch) return sessionsFetch;
  sessionsFetch = prisma.sessionInvalidation
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
      sessionsToInvalidate = toInvalidate;
      return sessionsToInvalidate;
    })
    .catch(() => {
      sessionsToInvalidate = {};
      return sessionsToInvalidate;
    });

  return sessionsFetch;
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

  const refreshedUser = await prisma.user.findFirst({ where: { id: user.id, deletedAt: null } });
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
