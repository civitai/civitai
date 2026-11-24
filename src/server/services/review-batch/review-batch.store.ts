import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { boundedClusterCall } from '~/server/utils/cluster-window-count';

/**
 * Redis keys of the review sheet batches, on the cache cluster. The moderator app reads `batchKey`
 * under the same name. A batch and its key's set are in different slots, so every write here
 * touches one key. A batch the cluster evicts stops opening; a set entry it evicts lets this
 * revoke miss that batch, which the moderator app still refuses once its minting key is gone
 * (`mintingKeyLive`).
 */
export const batchKey = (hash: string) => `${REDIS_KEYS.APP.REVIEW_BATCH}:${hash}` as const;
export const keySetKey = (keyId: number) => `${REDIS_KEYS.APP.REVIEW_BATCH_KEY}:${keyId}` as const;

/** One bounded cache-cluster call; throws on a failure, a timeout or an open breaker. */
export const reviewBatchCall = <T>(fn: string, op: () => Promise<T>) =>
  boundedClusterCall(`reviewBatch.${fn}`, op);

/** The batch first: once it is gone it no longer opens, whatever happens to the set entry. */
export async function deleteBatch(hash: string, keyId: number) {
  await reviewBatchCall('delete.batch', () => redis.del(batchKey(hash)));
  await reviewBatchCall('delete.keySet', () => redis.sRem(keySetKey(keyId), hash));
}

/** Every live batch the given API keys minted stops opening; for the paths that revoke a key. */
export async function revokeReviewBatchesOfKeys(keyIds: number[]) {
  for (const keyId of keyIds) {
    try {
      const hashes = await reviewBatchCall('revoke.members', () =>
        redis.sMembers(keySetKey(keyId))
      );
      // The cluster client deletes an array of keys one key at a time, never as one DEL.
      if (hashes.length)
        await reviewBatchCall('revoke.batches', () =>
          redis.del(hashes.map((hash) => batchKey(hash)))
        );
      await reviewBatchCall('revoke.keySet', () => redis.del(keySetKey(keyId)));
    } catch (e) {
      void logToAxiom({
        name: 'review-batch-revoke-failed',
        type: 'error',
        keyId,
        message: (e as Error).message,
      });
    }
  }
}
