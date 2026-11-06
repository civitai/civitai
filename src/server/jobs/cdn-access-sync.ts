import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  reconcileCdnAccess,
  retryTakedownPersists,
  syncCdnAccess,
} from '~/server/services/cdn-access.service';
import { createJob } from './job';

// Both default-off: isFlipt is false for an unknown flag or an unreachable Flipt. While off, the
// triggers keep queueing and the queue drains once the flag is turned on.
export const cdnAccessSync = createJob('cdn-access-sync', '* * * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CDN_ACCESS_SYNC))) return { reason: 'flag-off' };
  const sync = await syncCdnAccess();
  return { ...sync, persistRetries: await retryTakedownPersists() };
});

export const cdnAccessReconcile = createJob('cdn-access-reconcile', '40 4 * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CDN_ACCESS_SYNC))) return { reason: 'flag-off' };
  return reconcileCdnAccess();
});
