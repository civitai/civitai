import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { deleteManyObjects } from '~/utils/s3-utils';

const getVaultItemObjectKeys = ({
  userId,
  modelVersionId,
}: {
  userId: number;
  modelVersionId: number;
}) =>
  [constants.vault.keys.details, constants.vault.keys.images, constants.vault.keys.cover].map(
    (key) =>
      key
        .replace(':modelVersionId', modelVersionId.toString())
        .replace(':userId', userId.toString())
  );

// DeleteObjects accepts at most 1,000 keys per request, and each item has 3.
const VAULT_ITEMS_PER_OBJECT_DELETE = 333;

/**
 * Deletes the stored objects BEFORE the rows. A row is the only record of its keys, so deleting it
 * first turns any object-delete failure into objects nothing can find again. An item whose keys did
 * not all delete keeps its row and is reported in `failedModelVersionIds`, so a retry can finish it.
 */
export const deleteVaultItems = async ({
  userId,
  modelVersionIds,
}: {
  userId: number;
  modelVersionIds: number[];
}) => {
  const failed = new Set<number>();

  if (env.S3_VAULT_BUCKET) {
    for (let i = 0; i < modelVersionIds.length; i += VAULT_ITEMS_PER_OBJECT_DELETE) {
      const chunk = modelVersionIds.slice(i, i + VAULT_ITEMS_PER_OBJECT_DELETE);
      const modelVersionIdByKey = new Map<string, number>();
      for (const modelVersionId of chunk)
        for (const key of getVaultItemObjectKeys({ userId, modelVersionId }))
          modelVersionIdByKey.set(key, modelVersionId);

      const result = await deleteManyObjects(env.S3_VAULT_BUCKET, [...modelVersionIdByKey.keys()]);
      for (const error of result.Errors ?? []) {
        const modelVersionId = error.Key ? modelVersionIdByKey.get(error.Key) : undefined;
        // An error we cannot attribute to one item could belong to any of them.
        if (modelVersionId === undefined) chunk.forEach((id) => failed.add(id));
        else failed.add(modelVersionId);
      }
    }
  }

  const removedModelVersionIds = modelVersionIds.filter((id) => !failed.has(id));
  if (removedModelVersionIds.length) {
    await dbWrite.vaultItem.deleteMany({
      where: { vaultId: userId, modelVersionId: { in: removedModelVersionIds } },
    });
  }

  return { removedModelVersionIds, failedModelVersionIds: [...failed] };
};
