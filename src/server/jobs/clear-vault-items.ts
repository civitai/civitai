import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { deleteVaultItems } from '~/server/services/vault-item-deletion';
import type { JobContext } from './job';
import { createJob } from './job';

type OverCapVault = {
  userId: number;
  storageKb: number;
};

// A run stops at whichever cap it reaches first and the next run picks up from a fresh selection,
// so a backlog drains over several days instead of in one run that can outlive its lock.
export const CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN = 5000;
// Below the job's 5-minute lock, so a retried trigger cannot start a second run over the same vaults.
export const CLEAR_VAULT_ITEMS_TIME_BUDGET_MS = 4 * 60 * 1000;
const BATCH_SIZE = 50;

const log = (data: MixedObject) => {
  logToAxiom({ name: 'clear-vault-items', ...data }, 'webhooks').catch(() => undefined);
};

// Guard: compare usage against the *effective* limit — the greater of the
// stored `storageKb` and the user's current active entitlement. `storageKb`
// can drift below the real entitlement during a tier handoff (see
// reconcile-vault-storage.ts), and we must never delete a paying member's
// files because of a stale-low capacity counter. Only genuinely over-limit
// vaults (used > both the stored and the entitled capacity) are cleared.
const getOverCapVaults = () =>
  dbWrite.$queryRaw<OverCapVault[]>`
    WITH active_entitlement AS (
      SELECT cs."userId", SUM((p.metadata->>'vaultSizeKb')::bigint)::int AS entitled_kb
      FROM "CustomerSubscription" cs
      JOIN "Product" p ON p.id = cs."productId"
      WHERE cs.status IN ('active', 'trialing')
        AND cs."currentPeriodEnd" >= NOW()
        AND (p.metadata->>'vaultSizeKb') IS NOT NULL
      GROUP BY cs."userId"
    )
    SELECT
      v."userId",
      GREATEST(v."storageKb", COALESCE(ae.entitled_kb, 0)) as "storageKb"
    FROM "Vault" v
    LEFT JOIN "VaultItem" vi ON v."userId" = vi."vaultId"
    LEFT JOIN active_entitlement ae ON ae."userId" = v."userId"
    WHERE v."updatedAt" < NOW() - INTERVAL '2 month'
    GROUP BY
      v."userId", v."storageKb", ae.entitled_kb
    HAVING COALESCE(SUM(vi."detailsSizeKb" + vi."imagesSizeKb" + vi."modelSizeKb")::int, 0) > GREATEST(v."storageKb", COALESCE(ae.entitled_kb, 0))
  `;

// Read per batch rather than once per run: a usage figure captured before another run (or the
// member) removed items would keep deleting past the cap.
const getUsedStorageKb = async (userId: number) => {
  const { _sum } = await dbWrite.vaultItem.aggregate({
    where: { vaultId: userId },
    _sum: { detailsSizeKb: true, imagesSizeKb: true, modelSizeKb: true },
  });
  return (_sum.detailsSizeKb ?? 0) + (_sum.imagesSizeKb ?? 0) + (_sum.modelSizeKb ?? 0);
};

async function trimVault({
  vault,
  maxItems,
  shouldStop,
}: {
  vault: OverCapVault;
  maxItems: number;
  shouldStop: () => boolean;
}) {
  let deleted = 0;
  let batches = 0;
  let failedModelVersionIds: number[] = [];

  while (deleted < maxItems && !shouldStop()) {
    let overKb = (await getUsedStorageKb(vault.userId)) - vault.storageKb;
    if (overKb <= 0) break;

    const items = await dbWrite.vaultItem.findMany({
      where: { vaultId: vault.userId },
      select: { modelVersionId: true, detailsSizeKb: true, imagesSizeKb: true, modelSizeKb: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(BATCH_SIZE, maxItems - deleted),
    });

    const modelVersionIds: number[] = [];
    for (const item of items) {
      if (overKb <= 0) break;
      modelVersionIds.push(item.modelVersionId);
      overKb -= item.detailsSizeKb + item.imagesSizeKb + item.modelSizeKb;
    }
    if (!modelVersionIds.length) break;

    const result = await deleteVaultItems({ userId: vault.userId, modelVersionIds });
    batches++;
    deleted += result.removedModelVersionIds.length;
    // The oldest items are selected first, so a failed item would be selected again next batch.
    if (result.failedModelVersionIds.length) {
      failedModelVersionIds = result.failedModelVersionIds;
      break;
    }
  }

  return { deleted, batches, failedModelVersionIds };
}

export async function runClearVaultItems({
  jobContext,
  now = Date.now,
}: {
  jobContext: Pick<JobContext, 'status' | 'checkIfCanceled'>;
  now?: () => number;
}) {
  const startedAt = now();
  const deadline = startedAt + CLEAR_VAULT_ITEMS_TIME_BUDGET_MS;
  const outOfTime = () => now() >= deadline;
  const shouldStop = () => outOfTime() || jobContext.status !== 'running';

  const vaults = await getOverCapVaults();
  const summary = {
    vaultsOverCap: vaults.length,
    vaultsTrimmed: 0,
    vaultsFailed: 0,
    itemsDeleted: 0,
    batches: 0,
  };

  for (const vault of vaults) {
    jobContext.checkIfCanceled();
    if (summary.itemsDeleted >= CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN || outOfTime()) break;

    try {
      const result = await trimVault({
        vault,
        maxItems: CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN - summary.itemsDeleted,
        shouldStop,
      });
      summary.itemsDeleted += result.deleted;
      summary.batches += result.batches;
      if (result.deleted) summary.vaultsTrimmed++;
      if (result.failedModelVersionIds.length) {
        summary.vaultsFailed++;
        log({
          type: 'error',
          message: 'Vault objects failed to delete',
          userId: vault.userId,
          modelVersionIds: result.failedModelVersionIds,
        });
      }
    } catch (e) {
      summary.vaultsFailed++;
      const error = e as Error;
      log({ type: 'error', message: error.message, stack: error.stack, userId: vault.userId });
    }
  }

  const stoppedBy =
    summary.itemsDeleted >= CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN
      ? 'item-cap'
      : outOfTime()
      ? 'time-budget'
      : 'done';
  log({
    type: 'info',
    message: 'Run finished',
    ...summary,
    stoppedBy,
    elapsedMs: now() - startedAt,
  });
  return { ...summary, stoppedBy };
}

export const clearVaultItems = createJob('clear-vault-items', '0 0 * * *', async (jobContext) => {
  if (!env.S3_VAULT_BUCKET) {
    throw new Error('S3_VAULT_BUCKET is not defined');
  }

  return runClearVaultItems({ jobContext });
});
