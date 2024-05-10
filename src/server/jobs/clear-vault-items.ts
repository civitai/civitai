import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { removeModelVersionsFromVault } from '~/server/services/vault.service';
import { createJob } from './job';

type VaultWithUsedStorage = {
  userId: number;
  storageKb: number;
  usedStorageKb: number;
  updatedAt: Date;
};

// Runs once a day
export const clearVaultItems = createJob('clear-vault-items', '0 0 * * *', async () => {
  if (!env.S3_VAULT_BUCKET) {
    throw new Error('S3_VAULT_BUCKET is not defined');
  }

  // Find vaults that are over their storage limit.
  // Query looks a bit on the heavier side, but since it's running only once a day, should be ok generally speaking.
  const problemVaults = await dbWrite.$queryRaw<VaultWithUsedStorage[]>`
    SELECT
      v."userId",
      v."storageKb",  
      v."updatedAt",
      COALESCE(SUM(vi."detailsSizeKb" + vi."imagesSizeKb" + vi."modelSizeKb")::int, 0) as "usedStorageKb"
    FROM "Vault" v
    LEFT JOIN "VaultItem" vi ON v."userId" = vi."vaultId"
    WHERE v."updatedAt" < NOW() - INTERVAL '1 month'
    GROUP BY 
      v."userId"
    HAVING COALESCE(SUM(vi."detailsSizeKb" + vi."imagesSizeKb" + vi."modelSizeKb")::int, 0) > v."storageKb"
  `;

  for (const vault of problemVaults) {
    // I don't expect many vaults to be exceeded by over 50 items, but if it happens, we will need to run this loop multiple times.
    let removedKb = 0;
    while (true) {
      const items = await dbWrite.vaultItem.findMany({
        where: {
          vaultId: vault.userId,
        },
        take: 50,
        orderBy: {
          createdAt: 'asc',
        },
      });

      // Removed kb:
      const removedModelVersionIds = [];
      for (const item of items) {
        removedKb += item.detailsSizeKb + item.imagesSizeKb + item.modelSizeKb;
        removedModelVersionIds.push(item.modelVersionId);
        if (vault.usedStorageKb - removedKb <= vault.storageKb) {
          break;
        }
      }

      if (removedModelVersionIds.length === 0) {
        break;
      }

      await removeModelVersionsFromVault({
        userId: vault.userId,
        modelVersionIds: removedModelVersionIds,
      });

      if (vault.usedStorageKb - removedKb <= vault.storageKb) {
        break; // We are done. Otherwise, delete some more.
      }
    }
  }
});
