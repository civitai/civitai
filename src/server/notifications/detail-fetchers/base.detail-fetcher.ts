import { PrismaClient } from '@prisma/client';
import { BareNotification } from '~/server/notifications/base.notifications';

export function createDetailFetcher(fetcher: {
  types: string[];
  fetcher: (notifications: BareNotification[], ctx: { db: PrismaClient }) => Promise<void>;
}) {
  return fetcher;
}
