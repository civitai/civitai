import type { ModelType } from '~/shared/utils/prisma/enums';
import { ScanResultCode } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';

import { dbWrite } from '~/server/db/client';

import { createJob } from './job';
import { logToAxiom } from '~/server/logging/client';
import {
  createModelFileScanRequest,
  ModelFileScanSubmissionError,
} from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

// Fallback job: resubmits orchestrator scan workflows for files that were missed
// or whose scans stalled. Runs every 5 minutes, picks up files where:
// - virusScanResult is still Pending
// - scanRequestedAt is null (never submitted) or older than 1 day (stalled)
//
// This job is the ONLY drain on the pending-scan queue, and a file that cannot be
// submitted stays in that queue indefinitely — by design, because the alternative
// (giving up permanently) is the `exists=false` tombstone that left Published,
// Public files permanently unscanned. Since we cannot bound the queue by dropping
// work, we bound the WORK PER RUN instead, on three axes:
//   1. fairness  — nulls-first ordering, so never-submitted files always win a slot
//   2. backoff   — a failing file costs a slot every 30 min, not every 5 min
//   3. budget    — a fully-failing batch stops starting work before its lock expires
const SCAN_FALLBACK_CONCURRENCY = 10;
const SCAN_FALLBACK_BATCH_SIZE = 200;

/**
 * How long a file waits after a non-`not-found` submission failure before this
 * job considers it again.
 *
 * 🔴 ENCODING — do NOT "simplify" the `now() - 1 day + backoff` arithmetic below.
 * This job's eligibility predicate is
 *   `scanRequestedAt IS NULL OR scanRequestedAt < now() - 1 day`
 * and it recomputes `now() - 1 day` on every run, so that cutoff is a MOVING
 * target. Writing a timestamp of `now() - 1 day + BACKOFF` therefore parks the
 * row just ahead of the cutoff and lets it become eligible again in exactly
 * BACKOFF, while leaving the 24h stale-recovery semantics untouched for every
 * other file. The two obvious "simplifications" are both wrong:
 *   - `null`  — the previous behaviour. Re-eligible on the very next 5-minute
 *     tick, and each retry can burn a concurrency slot for 60s inside the
 *     submission pre-flight's resolve→sleep→resolve path. A permanently-failing
 *     file is then retried 288x/day, forever, crowding out real work.
 *   - `now()` — hides the file for the full 24h stale window, which is far too
 *     long for the transient orchestrator/resolver outages that are the common
 *     cause of submission failure.
 */
const SCAN_FALLBACK_RETRY_BACKOFF_MINUTES = 30;

/**
 * Wall-clock budget for a single run. Once spent, the job stops STARTING new
 * submissions; files it never attempted are released for the next tick.
 *
 * Sized against the job's own lock, which is `lockExpiration: 5 * 60` = 300s
 * (the `createJob` default — this job passes no options). The budget must leave
 * room for the LAST task admitted to finish after it starts:
 *   - the submission pre-flight sleeps a fixed 60s between its two
 *     `resolveDownloadUrl` attempts, which is the one tail component this code
 *     can actually bound, plus
 *   - two resolver round-trips and the final DB write.
 * 180s spends at most 60% of the lock on admitting work and reserves the
 * remaining 120s for that tail.
 *
 * 🔴 This bounds work STARTED, not run duration: the resolver calls use `fetch`
 * with no explicit timeout, so a hung request can still outlive the lock. The
 * budget makes a fully-failing 200-file batch stop at ~180s instead of running
 * 200/10 x 60s ~ 20 minutes against a 300s lock; it is not a hard deadline.
 */
const SCAN_FALLBACK_RUN_BUDGET_MS = 180 * 1000;

/**
 * Timestamp that re-opens a file for retry in ~SCAN_FALLBACK_RETRY_BACKOFF_MINUTES.
 * See SCAN_FALLBACK_RETRY_BACKOFF_MINUTES for why it is expressed this way.
 */
const retryBackoffAt = () =>
  dayjs().subtract(1, 'day').add(SCAN_FALLBACK_RETRY_BACKOFF_MINUTES, 'minute').toDate();

// Job key kept as `scan-files-fallback` for operational continuity with the
// pre-deprecation cron registry. The legacy `scan-files` job was removed when
// the orchestrator path became the only scan path.
export const scanFilesFallbackJob = createJob('scan-files-fallback', '*/5 * * * *', async () => {
  const scanCutOff = dayjs().subtract(1, 'day').toDate();

  const files = await dbWrite.modelFile.findMany({
    where: {
      virusScanResult: ScanResultCode.Pending,
      AND: [
        { OR: [{ exists: null }, { exists: true }] },
        { OR: [{ scanRequestedAt: null }, { scanRequestedAt: { lt: scanCutOff } }] },
      ],
    },
    select: {
      id: true,
      url: true,
      modelVersion: {
        select: {
          id: true,
          baseModel: true,
          model: { select: { id: true, type: true } },
        },
      },
    },
    // Fairness: never-submitted files (scanRequestedAt IS NULL) first, then the
    // longest-waiting. Without an explicit order the batch is whatever Postgres
    // hands back, so a failing population larger than SCAN_FALLBACK_BATCH_SIZE
    // can fill every batch with the same files and starve new uploads forever.
    // 🔴 `nulls: 'first'` is load-bearing and NOT the default — Postgres orders
    // ASC with NULLS LAST, so a bare `{ scanRequestedAt: 'asc' }` would sort
    // never-submitted files LAST and make the starvation worse, not better.
    orderBy: [{ scanRequestedAt: { sort: 'asc', nulls: 'first' } }],
    take: SCAN_FALLBACK_BATCH_SIZE,
  });

  if (files.length === 0) return { submitted: 0 };

  // Mark batch as requested upfront so overlapping runs won't re-process
  await dbWrite.modelFile.updateMany({
    where: { id: { in: files.map((f) => f.id) } },
    data: { scanRequestedAt: new Date() },
  });

  const runStartedAt = Date.now();

  let submitted = 0;
  let failed = 0;
  let skipped = 0;
  await limitConcurrency(
    files.map((file) => async () => {
      // Run budget: stop admitting new submissions once the run has spent its
      // wall-clock allowance. This file was never attempted, so release it with
      // scanRequestedAt=null — it should be immediately eligible on the next
      // tick, NOT pushed behind the retry backoff (which is for files that were
      // tried and failed). The upfront updateMany already stamped it, so
      // without this reset it would be hidden for the full 24h stale window.
      if (Date.now() - runStartedAt > SCAN_FALLBACK_RUN_BUDGET_MS) {
        skipped++;
        await dbWrite.modelFile
          .update({ where: { id: file.id }, data: { scanRequestedAt: null } })
          .catch(() => null);
        return;
      }

      // Defensive: a soft-deleted ModelVersion would null this out and crash
      // the whole batch. Skip and count as failed instead.
      if (!file.modelVersion) {
        failed++;
        // Back off rather than reset: a soft-deleted ModelVersion never starts
        // resolving again, so a null reset re-picks this file every 5 minutes
        // forever. The 24h stale sweep still recovers it if that ever changes.
        await dbWrite.modelFile
          .update({ where: { id: file.id }, data: { scanRequestedAt: retryBackoffAt() } })
          .catch(() => null);
        return;
      }
      try {
        await createModelFileScanRequest({
          fileId: file.id,
          modelVersionId: file.modelVersion.id,
          modelId: file.modelVersion.model.id,
          modelType: file.modelVersion.model.type as ModelType,
          baseModel: file.modelVersion.baseModel,
          url: file.url,
          priority: 'low',
        });
        submitted++;
      } catch (err) {
        failed++;
        const isNotFound = err instanceof ModelFileScanSubmissionError && err.code === 'not-found';
        if (isNotFound) {
          // Orchestrator says the AIR can't be resolved — file is genuinely
          // gone. Tombstone via exists=false so this job's WHERE clause skips
          // it on subsequent runs (`{ OR: [{ exists: null }, { exists: true }] }`).
          await dbWrite.modelFile
            .update({ where: { id: file.id }, data: { exists: false } })
            .catch(() => null);
        } else {
          // Transient failure: back this file off instead of resetting it, so
          // the next attempt lands in ~SCAN_FALLBACK_RETRY_BACKOFF_MINUTES
          // rather than on the next 5-min tick. A null reset here is what let a
          // permanently-failing file re-enter every single run and burn a
          // concurrency slot in the 60s pre-flight each time; the 24h
          // stale-cutoff window on its own is too long for the transient
          // orchestrator outages that are the common case for submission
          // failures (vs. workflow-level failures handled by D4).
          await dbWrite.modelFile
            .update({ where: { id: file.id }, data: { scanRequestedAt: retryBackoffAt() } })
            .catch(() => null);
        }
        logToAxiom(
          {
            type: 'error',
            name: 'scan-files-fallback',
            message: `Failed to submit scan workflow for file ${file.id}`,
            submissionErrorCode:
              err instanceof ModelFileScanSubmissionError ? err.code : 'transient',
            tombstoned: isNotFound,
            error: err instanceof Error ? err.message : String(err),
          },
          'webhooks'
        ).catch();
      }
    }),
    SCAN_FALLBACK_CONCURRENCY
  );

  // Only emitted when the budget actually truncated a run — i.e. the queue is
  // oversubscribed for the batch size. Silent on a healthy run.
  if (skipped > 0) {
    logToAxiom(
      {
        type: 'warning',
        name: 'scan-files-fallback',
        message: `Run budget exhausted; ${skipped} file(s) deferred to the next tick`,
        submitted,
        failed,
        skipped,
        batchSize: files.length,
        runBudgetMs: SCAN_FALLBACK_RUN_BUDGET_MS,
        elapsedMs: Date.now() - runStartedAt,
      },
      'webhooks'
    ).catch();
  }

  return { submitted, failed, skipped };
});
