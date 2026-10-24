import { withDistributedLock } from '~/server/utils/distributed-lock';
import { throwConflictError } from '~/server/utils/errorHandling';

const LOCK_TTL_SECONDS = 120;

/** One schedule write per creator at a time: the gap and daily-cap checks read the creator's
 *  posts and then write, so two concurrent requests validated against the same snapshot could
 *  together breach both. The loser waits briefly, then is told to retry. */
export async function withPostScheduleLock<T>(userId: number, operation: () => Promise<T>) {
  const outcome = await withDistributedLock(
    {
      key: `post-schedule:${userId}`,
      ttl: LOCK_TTL_SECONDS,
      retryDelay: 250,
      maxRetries: 20,
      autoRenew: true,
    },
    operation
  );
  if (outcome === null)
    throw throwConflictError('Another scheduling request is still running. Try again in a moment.');
  return outcome;
}
