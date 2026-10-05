import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { deleteManyObjects, getS3Client } from '~/utils/s3-utils';

const VAULT_ITEM_OBJECT_KEYS = [
  constants.vault.keys.details,
  constants.vault.keys.images,
  constants.vault.keys.cover,
];

const getVaultItemObjectKeys = ({
  userId,
  modelVersionId,
}: {
  userId: number;
  modelVersionId: number;
}) =>
  VAULT_ITEM_OBJECT_KEYS.map((key) =>
    key.replace(':modelVersionId', modelVersionId.toString()).replace(':userId', userId.toString())
  );

// DeleteObjects accepts at most 1,000 keys per request.
const VAULT_ITEMS_PER_OBJECT_DELETE = Math.floor(1000 / VAULT_ITEM_OBJECT_KEYS.length);
// The S3 client sets no request timeout; without one a hung delete outlives the caller's time budget.
export const VAULT_OBJECT_DELETE_TIMEOUT_MS = 30 * 1000;

/**
 * Objects go before rows: a row is the only record of its keys, so deleting it first orphans any
 * object whose delete fails. An item whose keys did not all delete keeps its row and is returned in
 * `failedModelVersionIds`. Each chunk's rows go right after its objects, so a throw part-way leaves
 * no row whose objects are already gone.
 */
export const deleteVaultItems = async ({
  userId,
  modelVersionIds,
}: {
  userId: number;
  modelVersionIds: number[];
}) => {
  const removedModelVersionIds: number[] = [];
  const failedModelVersionIds: number[] = [];
  const bucket = env.S3_VAULT_BUCKET;
  const s3 = bucket ? getS3Client() : null;

  for (let i = 0; i < modelVersionIds.length; i += VAULT_ITEMS_PER_OBJECT_DELETE) {
    const chunk = modelVersionIds.slice(i, i + VAULT_ITEMS_PER_OBJECT_DELETE);
    const failed = new Set<number>();

    if (bucket && s3) {
      const modelVersionIdByKey = new Map<string, number>();
      for (const modelVersionId of chunk)
        for (const key of getVaultItemObjectKeys({ userId, modelVersionId }))
          modelVersionIdByKey.set(key, modelVersionId);

      const result = await deleteManyObjects(bucket, [...modelVersionIdByKey.keys()], s3, {
        abortSignal: AbortSignal.timeout(VAULT_OBJECT_DELETE_TIMEOUT_MS),
      });
      for (const error of result.Errors ?? []) {
        if (error.Code === 'NoSuchKey') continue;
        const modelVersionId = error.Key ? modelVersionIdByKey.get(error.Key) : undefined;
        // An error we cannot attribute to one item could belong to any of them.
        if (modelVersionId === undefined) chunk.forEach((id) => failed.add(id));
        else failed.add(modelVersionId);
      }
    }

    const removed = chunk.filter((id) => !failed.has(id));
    if (removed.length) {
      await dbWrite.vaultItem.deleteMany({
        where: { vaultId: userId, modelVersionId: { in: removed } },
      });
    }
    removedModelVersionIds.push(...removed);
    failedModelVersionIds.push(...failed);
  }

  return { removedModelVersionIds, failedModelVersionIds };
};
