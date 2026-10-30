import type { PrismaClient } from '@prisma/client';
import type { BareNotification } from '~/server/notifications/base.notifications';

export type DetailFetcherContext = {
  db: PrismaClient;
  /** Whether the reader gets a model's .com face (`showsSfwFace`). */
  showSfwFace: boolean;
};

export function createDetailFetcher(fetcher: {
  types: string[];
  fetcher: (notifications: BareNotification[], ctx: DetailFetcherContext) => Promise<void>;
}) {
  return fetcher;
}
