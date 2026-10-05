import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';

const log = createLogger('push-subscription-cleanup', 'blue');

/**
 * A subscription that has not accepted a push in this long is a browser profile that no longer
 * exists (reinstall, cleared site data) — the push service would eventually 410 it, but only if we
 * kept trying. Rows with `lastSuccessAt` NULL are aged by `createdAt` instead: a subscription that
 * never once delivered is equally dead.
 */
const STALE_DAYS = 180;

export const pushSubscriptionCleanupJob = createJob(
  'push-subscription-cleanup',
  '30 4 * * 1',
  async () => {
    const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await dbWrite.pushSubscription.deleteMany({
      where: {
        OR: [{ lastSuccessAt: { lt: cutoff } }, { lastSuccessAt: null, createdAt: { lt: cutoff } }],
      },
    });
    log(`deleted ${count} stale push subscriptions (no delivery since ${cutoff.toISOString()})`);
    return { deleted: count };
  },
  { lockExpiration: 5 * 60 }
);
