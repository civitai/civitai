import { randomUUID } from 'crypto';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { OUTPUT_UNLOCK_LOCK_TTL_SECONDS } from '~/server/services/blocks/block-output-unlock.service';

export function outputUnlockLockKey(workflowId: string): string {
  return `${REDIS_SYS_KEYS.BLOCKS.OUTPUT_UNLOCK_LOCK}:${workflowId}`;
}

/**
 * Take the per-workflow unlock lock: `SET NX EX`, so a concurrent second unlock of the same
 * workflow (a double click, a retry racing the first call) is refused instead of reaching the
 * orchestrator twice. Returns the release, or `null` when another unlock holds it.
 *
 * The TTL outlives every bounded call made under the lock, so the lock cannot lapse mid-unlock;
 * the release deletes the key only while it still holds this caller's token, so a release after
 * a lapse cannot free someone else's lock. Fail-CLOSED: a Redis error refuses the unlock.
 */
export async function acquireOutputUnlockLock(
  workflowId: string
): Promise<(() => Promise<void>) | null> {
  const key = outputUnlockLockKey(workflowId);
  const owner = randomUUID();
  const acquired = await sysRedis.set(key as never, owner, {
    NX: true,
    EX: OUTPUT_UNLOCK_LOCK_TTL_SECONDS,
  });
  if (!acquired) return null;
  return async () => {
    try {
      if ((await sysRedis.get(key as never)) === owner) await sysRedis.del(key as never);
    } catch {
      // The TTL frees it.
    }
  };
}
