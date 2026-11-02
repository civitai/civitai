import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { purgeViewerDocuments } from '~/server/services/apps/doc-store-purge';
import type { DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';
import { isAccountUnderLegalHold } from '~/server/services/legal-hold.service';
import type { JobContext } from './job';
import { createJob } from './job';

/**
 * APP-DATA REMOVAL FOR DELETED ACCOUNTS — the background half of "Also delete my data in apps"
 * on self-deletion (`deleteUser`, `removeAppData`).
 *
 * The deletion records the request in `User.meta.appDataRemoval = 'requested'`, in the same
 * transaction that deletes the account, so the request exists exactly when the deletion
 * committed. This job finds those accounts on the PRIMARY and wipes each one's App Blocks
 * document-store data in every app (`purgeViewerDocuments`: private documents, the shared
 * documents they authored, their marks and usage; see `doc-store-purge.ts`), then removes the
 * marker. Without the box nothing is wiped and a restore brings the account back with its app
 * data.
 *
 * Skipped, marker kept, and retried next run: an account under legal hold (or whose hold cannot
 * be read), and an account whose wipe left a namespace failed. An account restored before the job
 * reached it has no marker (`restoreUser` drops it) and is no longer deleted, so it is never
 * wiped; each account is re-checked immediately before its wipe. Idempotent: a wipe only removes
 * what is still there.
 */

/** Accounts wiped per run at most; a backlog drains over several runs. */
export const APP_DATA_REMOVAL_BATCH = 25;

export type RemoveDeletedAccountAppDataResult = {
  /** Accounts carrying the request that the run looked at. */
  scanned: number;
  wiped: number;
  /** Held, or the hold could not be read: left for a later run. */
  held: number;
  /** The wipe failed or left a namespace failed; retried next run. */
  failed: number;
  /** Rows the wipes removed: documents (private + authored shared) and marks. */
  docs: number;
};

async function stillRequested(userId: number): Promise<boolean> {
  const [row] = await dbWrite.$queryRaw<{ requested: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = ${userId}
        AND u."deletedAt" IS NOT NULL
        AND u.meta->>'appDataRemoval' = 'requested'
    ) AS requested
  `;
  return row?.requested === true;
}

export async function removeDeletedAccountAppData(
  opts: {
    store?: DocStoreMaintenance;
    batch?: number;
    jobContext?: Pick<JobContext, 'checkIfCanceled'>;
  } = {}
): Promise<RemoveDeletedAccountAppDataResult> {
  const batch = opts.batch ?? APP_DATA_REMOVAL_BATCH;
  const result: RemoveDeletedAccountAppDataResult = {
    scanned: 0,
    wiped: 0,
    held: 0,
    failed: 0,
    docs: 0,
  };
  // Oldest deletion first. A held or failing account stays in the list, so the batch is read
  // past them rather than letting them occupy it forever.
  const candidates = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT u.id FROM "User" u
    WHERE u."deletedAt" IS NOT NULL AND u.meta->>'appDataRemoval' = 'requested'
    ORDER BY u."deletedAt", u.id
    LIMIT ${batch * 4}
  `;
  for (const { id } of candidates) {
    if (result.wiped + result.failed >= batch) break;
    opts.jobContext?.checkIfCanceled();
    result.scanned += 1;
    if ((await isAccountUnderLegalHold(id)) !== false) {
      result.held += 1;
      continue;
    }
    if (!(await stillRequested(id))) continue;
    try {
      const wipe = await purgeViewerDocuments(id, { store: opts.store });
      result.docs += wipe.namespaces.reduce(
        (sum, ns) => sum + ns.privateDocs + ns.sharedDocs + ns.marks + ns.namespaceRows,
        0
      );
      if (wipe.failures.length > 0) {
        result.failed += 1;
        logToAxiom(
          {
            name: 'remove-deleted-account-app-data',
            type: 'error',
            userId: id,
            message: `${wipe.failures.length} namespace(s) failed`,
            failures: wipe.failures.slice(0, 5),
          },
          'webhooks'
        ).catch(() => undefined);
        continue;
      }
      // Only while still deleted: a restore that landed during the wipe already dropped it.
      await dbWrite.$executeRaw`
        UPDATE "User" SET meta = meta::jsonb - 'appDataRemoval'
        WHERE id = ${id} AND "deletedAt" IS NOT NULL
      `;
      result.wiped += 1;
    } catch (err) {
      // A disabled store fails every wipe alike; stop and keep every request for later.
      if (isDocStoreError(err, 'storage_disabled')) throw err;
      result.failed += 1;
      logToAxiom(
        {
          name: 'remove-deleted-account-app-data',
          type: 'error',
          userId: id,
          message: err instanceof Error ? err.message : String(err),
        },
        'webhooks'
      ).catch(() => undefined);
    }
  }
  return result;
}

/**
 * Every 10 minutes: a self-deletion's app data goes within minutes of the request. When there is
 * nothing to do a run is one read over deleted accounts. FAIL-OPEN like the sibling
 * reapers: an error is logged and the next run retries.
 */
export const removeDeletedAccountAppDataJob = createJob(
  'remove-deleted-account-app-data',
  '*/10 * * * *',
  async (jobContext) => {
    try {
      const result = await removeDeletedAccountAppData({ jobContext });
      if (result.scanned > 0) {
        logToAxiom(
          { name: 'remove-deleted-account-app-data', type: 'info', ...result },
          'webhooks'
        ).catch(() => undefined);
      }
      return result;
    } catch (error) {
      if (isDocStoreError(error, 'storage_disabled')) return { disabled: true as const };
      logToAxiom(
        {
          name: 'remove-deleted-account-app-data',
          type: 'error',
          message: (error as Error)?.message,
          stack: (error as Error)?.stack,
        },
        'webhooks'
      ).catch(() => undefined);
      return { error: true as const };
    }
  }
);
