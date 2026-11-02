import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { purgeAppDocuments } from '~/server/services/apps/doc-store-purge';
import {
  DocStoreMigrationPendingError,
  isDocStoreError,
} from '~/server/services/apps/doc-store.types';
import type { JobContext } from './job';
import { createJob } from './job';

/**
 * DELETED-APP STORAGE REAPER — delete a deleted app's App Blocks document-store data (every
 * user's, in every namespace: `prod` and every developer's `dev:<uid>`) once the app has been
 * deleted for `STORAGE_REAP_AFTER_DAYS` days, and not before.
 *
 * SOURCE OF TRUTH: `app_blocks.storage_deleted_at` (raw SQL only; migration
 * `20261218120000_app_block_storage_deleted_at`). An app is eligible while ALL of these hold,
 * read on the PRIMARY:
 *   - `storage_deleted_at` is at least `STORAGE_REAP_AFTER_DAYS` days old;
 *   - the block is not `approved` — an approved block is a live app, whatever the column says;
 *   - it has not been purged since that deletion (`storage_purged_at` is null or older).
 * A restored app has its `storage_deleted_at` cleared, or is `approved` again, so it is never
 * touched. The whole predicate is re-read before EVERY batch (`purgeAppDocuments`' `proceed`),
 * so a restore that lands mid-purge stops it within one batch.
 *
 * Batched, resumable and idempotent: each run deletes at most `STORAGE_REAP_ROWS_PER_RUN` rows
 * in transactions of `STORAGE_REAP_BATCH_ROWS`; an app it did not finish stays eligible and
 * continues next run, and only a finished purge stamps `storage_purged_at`.
 */

export const STORAGE_REAP_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Apps looked at per run. */
export const STORAGE_REAP_APPS_PER_RUN = 20;
/** Rows deleted per store transaction. */
export const STORAGE_REAP_BATCH_ROWS = 1000;
/** Rows deleted per run across all apps; a large app finishes over several runs. */
export const STORAGE_REAP_ROWS_PER_RUN = 50_000;

/**
 * A run that fails because a hand-applied migration has not run yet fails the same way every
 * hour until someone applies it, so it is logged at most once per `MIGRATION_LOG_EVERY_MS` per
 * process (and per migration), not on every run. Any other failure is logged every time.
 */
const MIGRATION_LOG_EVERY_MS = DAY_MS;
const migrationLoggedAt = new Map<string, number>();

/** Which pending migration `err` comes from, or null when it is some other failure. */
function pendingMigration(err: unknown): string | null {
  // The datastore's app-purge policy (`purgeApp` refuses without it).
  if (err instanceof DocStoreMigrationPendingError) return err.migration;
  // The main database's two `app_blocks` columns: Postgres 42703, undefined column. Prisma wraps a
  // raw query's error as P2010 with the driver's code in `meta.code`.
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  if (e?.code === '42703' || e?.meta?.code === '42703') {
    return '20261218120000_app_block_storage_deleted_at';
  }
  return null;
}

export type ReapDeletedAppStorageResult = {
  /** Eligible apps the run looked at. */
  scanned: number;
  /** Purge finished and stamped. */
  purged: number;
  /** Ran out of the run's row budget part-way; continues next run. */
  partial: number;
  /** Became ineligible mid-purge (restored): stopped, not stamped. */
  stopped: number;
  /** Failed; retried next run. */
  failed: number;
  /** Rows deleted across all apps. */
  rows: number;
};

/** Eligible block ids, oldest deletion first. `cutoff` = now − the waiting period. */
async function eligibleApps(cutoff: Date, limit: number): Promise<string[]> {
  const rows = await dbWrite.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM app_blocks b
    WHERE b.storage_deleted_at IS NOT NULL
      AND b.storage_deleted_at <= ${cutoff}
      AND b.status <> 'approved'
      AND (b.storage_purged_at IS NULL OR b.storage_purged_at < b.storage_deleted_at)
    ORDER BY b.storage_deleted_at, b.id
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

async function stillEligible(id: string, cutoff: Date): Promise<boolean> {
  const [row] = await dbWrite.$queryRaw<{ eligible: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM app_blocks b
      WHERE b.id = ${id}
        AND b.storage_deleted_at IS NOT NULL
        AND b.storage_deleted_at <= ${cutoff}
        AND b.status <> 'approved'
        AND (b.storage_purged_at IS NULL OR b.storage_purged_at < b.storage_deleted_at)
    ) AS eligible
  `;
  return row?.eligible === true;
}

export async function reapDeletedAppStorage(
  opts: {
    store?: DocStoreMaintenance;
    now?: Date;
    apps?: number;
    batchRows?: number;
    rowsPerRun?: number;
    jobContext?: Pick<JobContext, 'checkIfCanceled'>;
  } = {}
): Promise<ReapDeletedAppStorageResult> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - STORAGE_REAP_AFTER_DAYS * DAY_MS);
  const rowsPerRun = opts.rowsPerRun ?? STORAGE_REAP_ROWS_PER_RUN;
  const result: ReapDeletedAppStorageResult = {
    scanned: 0,
    purged: 0,
    partial: 0,
    stopped: 0,
    failed: 0,
    rows: 0,
  };
  for (const id of await eligibleApps(cutoff, opts.apps ?? STORAGE_REAP_APPS_PER_RUN)) {
    if (result.rows >= rowsPerRun) break;
    opts.jobContext?.checkIfCanceled();
    result.scanned += 1;
    try {
      const out = await purgeAppDocuments(id, {
        store: opts.store,
        batchRows: opts.batchRows ?? STORAGE_REAP_BATCH_ROWS,
        maxRows: rowsPerRun - result.rows,
        proceed: () => stillEligible(id, cutoff),
      });
      result.rows += out.rows;
      if (out.stopped) {
        result.stopped += 1;
      } else if (!out.done) {
        result.partial += 1;
      } else {
        // Stamped only while still eligible, so a restore that landed after the last batch
        // leaves no "purged" mark behind.
        await dbWrite.$executeRaw`
          UPDATE app_blocks SET storage_purged_at = now()
          WHERE id = ${id}
        `;
        result.purged += 1;
        logToAxiom(
          {
            name: 'reap-deleted-app-storage',
            type: 'info',
            appBlockId: id,
            namespaces: out.namespaces,
            rows: out.rows,
          },
          'webhooks'
        ).catch(() => undefined);
      }
    } catch (err) {
      // A disabled store or a missing migration fails every purge alike; stop rather than count
      // (and log) each one.
      if (isDocStoreError(err, 'storage_disabled') || pendingMigration(err)) throw err;
      result.failed += 1;
      logToAxiom(
        {
          name: 'reap-deleted-app-storage',
          type: 'error',
          appBlockId: id,
          message: err instanceof Error ? err.message : String(err),
        },
        'webhooks'
      ).catch(() => undefined);
    }
  }
  return result;
}

/**
 * Hourly at :50: an app at the largest ceiling (a million documents plus their marks) drains in a
 * day or two of runs within the row budget, and with nothing eligible a run is one read of the
 * partial index on `storage_deleted_at`. FAIL-OPEN like the sibling reapers: an error is logged and
 * the next run retries; a migration not applied yet (either one) is logged once a day.
 */
export const reapDeletedAppStorageJob = createJob(
  'reap-deleted-app-storage',
  '50 * * * *',
  async (jobContext) => {
    try {
      const result = await reapDeletedAppStorage({ jobContext });
      if (result.scanned > 0) {
        logToAxiom({ name: 'reap-deleted-app-storage', type: 'info', ...result }, 'webhooks').catch(
          () => undefined
        );
      }
      return result;
    } catch (error) {
      if (isDocStoreError(error, 'storage_disabled')) return { disabled: true as const };
      const migration = pendingMigration(error);
      if (migration) {
        const now = Date.now();
        const last = migrationLoggedAt.get(migration);
        if (last !== undefined && now - last < MIGRATION_LOG_EVERY_MS) {
          return { migrationPending: migration };
        }
        migrationLoggedAt.set(migration, now);
      }
      logToAxiom(
        {
          name: 'reap-deleted-app-storage',
          type: 'error',
          message: (error as Error)?.message,
          stack: (error as Error)?.stack,
          ...(migration ? { migrationPending: migration } : {}),
        },
        'webhooks'
      ).catch(() => undefined);
      return migration ? { migrationPending: migration } : { error: true as const };
    }
  }
);
