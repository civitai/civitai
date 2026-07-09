import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createJob } from './job';

type ReconciledVault = {
  userId: number;
  storageKb: number;
};

// Runs daily at 23:30, ahead of clearVaultItems (00:00), so a vault that drifted
// below its entitlement is restored before the deletion sweep can act on it.
//
// `Vault.storageKb` is the vault *capacity* (entitlement), sourced from the
// subscription product's `vaultSizeKb`. It is otherwise only recomputed on a
// subscription event (webhook / code redemption / manual reset). During a tier
// handoff there is a window where the recompute observes no active sub and zeroes
// the vault — and nothing re-runs it afterward, so capacity can stay wrongly low
// indefinitely even though the user holds an active, vault-bearing subscription.
// That under-provisioning is what trips the wind-down UI and the clearVaultItems
// deletion job. This sweep self-heals that drift.
//
// It only ever RAISES storageKb up to the current active entitlement; it never
// lowers it. Capacity reductions (downgrades / lapses) stay on the existing
// event-driven path, so this job cannot itself trigger wind-down or deletion.
export const reconcileVaultStorage = createJob(
  'reconcile-vault-storage',
  '30 23 * * *',
  async () => {
    const fixed = await dbWrite.$queryRaw<ReconciledVault[]>`
      WITH active_entitlement AS (
        SELECT cs."userId", SUM((p.metadata->>'vaultSizeKb')::bigint)::int AS entitled_kb
        FROM "CustomerSubscription" cs
        JOIN "Product" p ON p.id = cs."productId"
        WHERE cs.status IN ('active', 'trialing')
          AND cs."currentPeriodEnd" >= NOW()
          AND (p.metadata->>'vaultSizeKb') IS NOT NULL
        GROUP BY cs."userId"
      )
      UPDATE "Vault" v
      SET "storageKb" = ae.entitled_kb,
          "updatedAt" = NOW()
      FROM active_entitlement ae
      WHERE ae."userId" = v."userId"
        AND v."storageKb" < ae.entitled_kb
      RETURNING v."userId", v."storageKb"
    `;

    if (fixed.length > 0) {
      await logToAxiom({
        name: 'reconcile-vault-storage',
        type: 'info',
        message: `Restored vault capacity for ${fixed.length} under-provisioned vault(s)`,
        details: { userIds: fixed.map((f) => f.userId) },
      }).catch(() => null);
    }

    return { reconciled: fixed.length };
  }
);
