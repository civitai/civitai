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

// No resume state: the next run re-selects over-cap vaults, so a backlog drains across daily runs.
export const CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN = 5000;
// Below the job's 5-minute lock, so a retried trigger cannot start a second run over the same vaults.
export const CLEAR_VAULT_ITEMS_TIME_BUDGET_MS = 4 * 60 * 1000;
const BATCH_SIZE = 50;

const log = (data: MixedObject) => {
  logToAxiom({ name: 'clear-vault-items', ...data }, 'webhooks').catch(() => undefined);
};

// Compare against the greater of `storageKb` and the active entitlement: `storageKb` can lag the
// entitlement during a tier handoff (see reconcile-vault-storage.ts), and a stale-low counter must
// never delete a paying member's files.
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

const itemSizeKb = (item: { detailsSizeKb: number; imagesSizeKb: number; modelSizeKb: number }) =>
  item.detailsSizeKb + item.imagesSizeKb + item.modelSizeKb;

async function trimVault({
  vault,
  maxItems,
  shouldStop,
  now,
}: {
  vault: OverCapVault;
  maxItems: number;
  shouldStop: () => boolean;
  now: () => number;
}) {
  let deleted = 0;
  let batches = 0;
  let batchMs = 0;
  let underCap = false;
  let failedModelVersionIds: number[] = [];

  while (deleted < maxItems && !shouldStop()) {
    // Usage and the items to delete come from one read, re-taken every batch: the member can remove
    // items mid-run, and a stale figure keeps deleting past the cap.
    const items = await dbWrite.vaultItem.findMany({
      where: { vaultId: vault.userId },
      select: { modelVersionId: true, detailsSizeKb: true, imagesSizeKb: true, modelSizeKb: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let overKb = items.reduce((acc, item) => acc + itemSizeKb(item), 0) - vault.storageKb;
    if (overKb <= 0) {
      underCap = true;
      break;
    }

    const modelVersionIds: number[] = [];
    for (const item of items.slice(0, Math.min(BATCH_SIZE, maxItems - deleted))) {
      if (overKb <= 0) break;
      modelVersionIds.push(item.modelVersionId);
      overKb -= itemSizeKb(item);
    }

    const startedAt = now();
    const result = await deleteVaultItems({ userId: vault.userId, modelVersionIds });
    batchMs += now() - startedAt;
    batches++;
    deleted += result.removedModelVersionIds.length;
    // The oldest items are selected first, so a failed item would be selected again next batch.
    if (result.failedModelVersionIds.length) {
      failedModelVersionIds = result.failedModelVersionIds;
      break;
    }
    if (overKb <= 0) {
      underCap = true;
      break;
    }
  }

  return { deleted, batches, batchMs, underCap, failedModelVersionIds };
}

async function clearOverCapVaults({
  jobContext,
  now,
}: {
  jobContext: Pick<JobContext, 'status' | 'checkIfCanceled'>;
  now: () => number;
}) {
  const startedAt = now();
  const deadline = startedAt + CLEAR_VAULT_ITEMS_TIME_BUDGET_MS;
  const outOfTime = () => now() >= deadline;
  const shouldStop = () => outOfTime() || jobContext.status !== 'running';

  const vaults = await getOverCapVaults();
  const summary = {
    vaultsOverCap: vaults.length,
    vaultsTrimmed: 0,
    vaultsUnderCap: 0,
    vaultsFailed: 0,
    itemsDeleted: 0,
    batches: 0,
  };
  let batchMs = 0;

  for (const vault of vaults) {
    jobContext.checkIfCanceled();
    if (summary.itemsDeleted >= CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN || outOfTime()) break;

    try {
      const result = await trimVault({
        vault,
        maxItems: CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN - summary.itemsDeleted,
        shouldStop,
        now,
      });
      summary.itemsDeleted += result.deleted;
      summary.batches += result.batches;
      batchMs += result.batchMs;
      if (result.deleted) summary.vaultsTrimmed++;
      if (result.underCap) summary.vaultsUnderCap++;
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

  const result = {
    ...summary,
    vaultsLeftOverCap: summary.vaultsOverCap - summary.vaultsUnderCap,
    avgBatchMs: summary.batches ? Math.round(batchMs / summary.batches) : 0,
    elapsedMs: now() - startedAt,
    stoppedBy:
      summary.itemsDeleted >= CLEAR_VAULT_ITEMS_MAX_ITEMS_PER_RUN
        ? 'item-cap'
        : outOfTime()
        ? 'time-budget'
        : 'done',
  };
  log({ type: 'info', message: 'Run finished', ...result });
  return result;
}

export async function runClearVaultItems({
  jobContext,
  now = Date.now,
}: {
  jobContext: Pick<JobContext, 'status' | 'checkIfCanceled'>;
  now?: () => number;
}) {
  // Without a bucket, deleteVaultItems removes rows and no objects: every object would be orphaned.
  if (!env.S3_VAULT_BUCKET) throw new Error('S3_VAULT_BUCKET is not defined');

  return clearOverCapVaults({ jobContext, now });
}

export const clearVaultItems = createJob('clear-vault-items', '0 0 * * *', (jobContext) =>
  runClearVaultItems({ jobContext })
);
