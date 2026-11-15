import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/** Redis keys of the review sheet batches. The moderator app reads `batchKey` under the same name. */
export const batchKey = (hash: string) => `${REDIS_SYS_KEYS.APP.REVIEW_BATCH}:${hash}` as const;
export const keySetKey = (keyId: number) =>
  `${REDIS_SYS_KEYS.APP.REVIEW_BATCH_KEY}:${keyId}` as const;

export async function deleteBatch(hash: string, keyId: number) {
  await sysRedis.multi().del(batchKey(hash)).sRem(keySetKey(keyId), hash).exec();
}

/** Every live batch the given API keys minted stops opening; for the paths that revoke a key. */
export async function revokeReviewBatchesOfKeys(keyIds: number[]) {
  for (const keyId of keyIds) {
    try {
      const hashes = await sysRedis.sMembers(keySetKey(keyId));
      if (hashes.length) await sysRedis.del(hashes.map((hash) => batchKey(hash)));
      await sysRedis.del(keySetKey(keyId));
    } catch (e) {
      void logToAxiom({
        name: 'review-batch-revoke-failed',
        type: 'error',
        keyId,
        message: (e as Error).message,
      }).catch(() => null);
    }
  }
}
