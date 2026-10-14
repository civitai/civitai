import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { recordReviewStorageSweep } from '~/server/metrics/app-block-runtime.metrics';
import type { DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { getDocStoreMaintenance } from '~/server/services/apps/doc-store-maintenance.instance';
import { isDocStoreError } from '~/server/services/apps/doc-store.types';
import type { JobContext } from './job';
import { createJob } from './job';

/**
 * REVIEW-STORAGE SWEEP — delete the document-store review namespaces
 * (`rev:<publishRequestId>:<moderatorUid>`) of every publish request that is no longer pending.
 *
 * Approve, reject and withdraw purge their request inline
 * (`teardownReviewStorageForRequest`). This sweep finishes everything that path cannot:
 *   - requests SUPERSEDED (withdrawn by a newer push or by another request's approve), which
 *     no inline call covers;
 *   - an inline purge that FAILED (store unreachable, lock timeout);
 *   - a write that passed the resolver's `pending` check before the decision and committed
 *     after the inline purge;
 *   - a request whose row no longer exists (deleted with its submitter's account).
 *
 * It lists the requests that still hold review data from the store (a review-maintenance read,
 * `DocStoreMaintenance.listReviewAppIds`), reads their status from the PRIMARY — a replica that has not
 * yet seen a new request would read it as missing, and missing means "purge" — and purges each
 * one that is approved, rejected or withdrawn, or whose row is gone. A pending request is never
 * touched. Idempotent: a purged request no longer lists.
 */

/**
 * The statuses whose review data is purged. An ALLOWLIST of final states, not "anything but
 * pending": a status added later is kept until someone decides it is final. A request whose row
 * no longer exists is purged too (its data can no longer be reached).
 */
export const REVIEW_STORAGE_PURGEABLE_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'rejected',
  'withdrawn',
]);

/** Requests purged per run at most; a backlog drains over several runs. */
export const REVIEW_STORAGE_SWEEP_BATCH = 50;

/** Request ids listed per page (pending ones are skipped, so a run may read several pages). */
export const REVIEW_STORAGE_SWEEP_PAGE = 200;

export type SweepReviewStorageResult = {
  /** Requests holding review data that the run looked at. */
  scanned: number;
  /** Still pending, or in a status not known to be final: left alone. */
  kept: number;
  purged: number;
  /** Purge failed; the request lists again next run. */
  failed: number;
};

/** Core sweep, exported for tests (the service-fn + thin-job-wrapper split of the sibling reapers). */
export async function sweepReviewStorage(
  opts: {
    store?: DocStoreMaintenance;
    batch?: number;
    page?: number;
    jobContext?: Pick<JobContext, 'checkIfCanceled'>;
  } = {}
): Promise<SweepReviewStorageResult> {
  const store = opts.store ?? getDocStoreMaintenance();
  const batch = opts.batch ?? REVIEW_STORAGE_SWEEP_BATCH;
  const page = opts.page ?? REVIEW_STORAGE_SWEEP_PAGE;
  const result: SweepReviewStorageResult = { scanned: 0, kept: 0, purged: 0, failed: 0 };

  let after = '';
  for (;;) {
    const ids = await store.listReviewAppIds({ after, limit: page });
    if (ids.length === 0) break;
    const rows = await dbWrite.appBlockPublishRequest.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    const status = new Map(rows.map((r) => [r.id, r.status]));
    for (const id of ids) {
      if (result.purged + result.failed >= batch) return result;
      opts.jobContext?.checkIfCanceled();
      after = id;
      result.scanned += 1;
      const s = status.get(id);
      if (s !== undefined && !REVIEW_STORAGE_PURGEABLE_STATUSES.has(s)) {
        result.kept += 1;
        continue;
      }
      try {
        await store.purgeReview(id);
        result.purged += 1;
        recordReviewStorageSweep('purged');
      } catch (err) {
        // A disabled store fails every purge alike; stop rather than count each one.
        if (isDocStoreError(err, 'storage_disabled')) throw err;
        result.failed += 1;
        recordReviewStorageSweep('failed');
        logToAxiom(
          {
            name: 'sweep-review-storage',
            type: 'error',
            publishRequestId: id,
            message: err instanceof Error ? err.message : String(err),
          },
          'webhooks'
        ).catch(() => undefined);
      }
    }
    if (ids.length < page) break;
  }
  return result;
}

/**
 * Hourly, at :35 — beside the hourly `purge-review-snapshots` (:20) and off its minute. Inline
 * cleanup handles the common case, so this only bounds how long leftovers outlive their request
 * (an hour) at the cost of one small read when there is nothing to do; review data is low
 * volume, so a tighter cadence buys nothing. FAIL-OPEN like the sibling reapers: an error is
 * logged and the next run retries.
 */
export const sweepReviewStorageJob = createJob(
  'sweep-review-storage',
  '35 * * * *',
  async (jobContext) => {
    try {
      const result = await sweepReviewStorage({ jobContext });
      if (result.scanned > 0) {
        logToAxiom({ name: 'sweep-review-storage', type: 'info', ...result }, 'webhooks').catch(
          () => undefined
        );
      }
      return result;
    } catch (error) {
      if (isDocStoreError(error, 'storage_disabled')) return { disabled: true as const };
      logToAxiom(
        {
          name: 'sweep-review-storage',
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
