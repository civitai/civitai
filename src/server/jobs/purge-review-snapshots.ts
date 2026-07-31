import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createJob, getJobDate } from './job';

/**
 * RETENTION SWEEP — purge the in-review source snapshot of an app whose publish
 * request has been terminally rejected/withdrawn for long enough.
 *
 * Every submission pushes the developer's source into a per-slug in-review
 * snapshot repo so moderators can review it. Once a request is rejected or
 * withdrawn nobody reads that snapshot again, but it sits there holding a full
 * copy of third-party source indefinitely. Keeping unreviewed third-party code
 * around forever, for no reader, is the kind of quiet accumulation that turns
 * one future misconfiguration into a large disclosure. So we reclaim it.
 *
 * WHY THIS IS SAFE TO DELETE: the snapshot is a DERIVED CACHE, never the system
 * of record. A ZIP submission's bundle lives in object storage under
 * `bundleKey`; a push submission's source lives in the canonical app repo at the
 * pinned `forgejoCommitSha`. Purging a snapshot loses nothing irreplaceable.
 *
 * WHY A SWEEP AND NOT AN INLINE DELETE ON REJECT: a sweep survives a missed
 * event (a reject that happened while this was broken/undeployed still gets
 * collected on a later run), it is naturally batched and bounded, and it keeps
 * the reject path — a moderator-facing write — free of a slow external call
 * that could fail it. Mirrors the existing ephemeral-resource reapers
 * (`reap-dev-tunnels`, `sweep-stale-agent-reviews`).
 */

/**
 * How long a publish request must have sat in a terminal (rejected/withdrawn)
 * state before its slug's snapshot is reclaimed.
 *
 * The delay is the point: it leaves a window in which a moderator can revisit a
 * contested rejection, or a developer can appeal, with the exact submitted tree
 * still browsable. Shortening this trades that window for storage; lengthening
 * it just holds third-party source longer. 30 days is comfortably past any
 * realistic appeal.
 */
export const REVIEW_SNAPSHOT_PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Max terminal rows examined per run. Bounds the work AND the number of delete
 * calls a single run can make against the review source host, so a large
 * backlog drains over several runs instead of in one burst.
 */
export const REVIEW_SNAPSHOT_PURGE_BATCH_SIZE = 50;

/** KeyValue cursor key — the resume point between runs. */
const PURGE_CURSOR_KEY = 'purge-review-snapshots';

/**
 * Terminal statuses that make a slug's snapshot eligible for reclamation.
 *
 * 🔴 `approved` is deliberately NOT here. An approved app's snapshot is out of
 * scope for this sweep — approval is a different lifecycle with its own
 * artifacts, and reclaiming there is a separate decision.
 */
const PURGEABLE_TERMINAL_STATUSES = ['rejected', 'withdrawn'] as const;

export type PurgeReviewSnapshotsResult = {
  /** Terminal rows examined this run. */
  scanned: number;
  /** Distinct slugs considered (rows dedupe to one delete attempt per slug). */
  candidates: number;
  /** Snapshots actually reclaimed. */
  deleted: number;
  /** Snapshots that were already gone — idempotent re-run, counted not failed. */
  alreadyGone: number;
  /** Slugs held back because a pending request still owns the snapshot. */
  skippedPending: number;
  /** Per-slug failures; the sweep continued past each. */
  failed: number;
};

const logPurge = (data: Record<string, unknown>) =>
  logToAxiom({ name: 'purge-review-snapshots', ...data }, 'webhooks').catch(() => undefined);

/**
 * Core sweep (exported for unit tests, mirroring the service-fn +
 * thin-job-wrapper split used by the sibling reapers).
 */
export async function purgeExpiredReviewSnapshots(
  opts: { now?: Date; batchSize?: number } = {}
): Promise<PurgeReviewSnapshotsResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? REVIEW_SNAPSHOT_PURGE_BATCH_SIZE;
  const cutoff = new Date(now.getTime() - REVIEW_SNAPSHOT_PURGE_AFTER_MS);

  const result: PurgeReviewSnapshotsResult = {
    scanned: 0,
    candidates: 0,
    deleted: 0,
    alreadyGone: 0,
    skippedPending: 0,
    failed: 0,
  };

  // Resumable cursor over the terminal-transition timestamp. `updatedAt` is the
  // reliable "when did this row go terminal" signal: `reviewedAt` is NULL for
  // withdrawn rows (the DB's review-pair CHECK exempts them), so it cannot be
  // used as the sole ordering key. A terminal row is never written again, so its
  // `updatedAt` is stable — which is what makes it safe to order and resume on.
  const [cursor, setCursor] = await getJobDate(PURGE_CURSOR_KEY, new Date(0));

  const rows = await dbRead.appBlockPublishRequest.findMany({
    where: {
      status: { in: [...PURGEABLE_TERMINAL_STATUSES] },
      // gt cursor: don't re-walk what previous runs already handled.
      // lt cutoff: THE RETENTION GATE — not yet 30 days terminal, not eligible.
      updatedAt: { gt: cursor, lt: cutoff },
    },
    orderBy: { updatedAt: 'asc' },
    take: batchSize,
    select: { id: true, slug: true, status: true, updatedAt: true },
  });

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  // One delete attempt per slug even if several of its old requests aged out in
  // the same batch — the snapshot is per-slug, not per-request.
  const slugs = Array.from(new Set(rows.map((r) => r.slug)));
  result.candidates = slugs.length;

  const { deleteReviewRepo } = await import('~/server/services/blocks/forgejo.service');

  for (const slug of slugs) {
    try {
      // 🔴 THE CORRECTNESS GATE. Snapshots are keyed per-slug and OVERWRITTEN on
      // every submit, so the repo a 40-day-old rejection points at may today
      // hold a brand-new, still-pending submission's source. Deleting it would
      // destroy an in-flight review. `pending` is the only non-terminal status,
      // so "a pending row exists for this slug" is exactly "someone still needs
      // this snapshot" — and we hold back.
      //
      // Read from the PRIMARY (`dbWrite`), not the replica: the row that must
      // block us can be seconds old (a developer resubmitting right now) while
      // the row that made us eligible is 30+ days old. A replica lagging by even
      // a moment would hide exactly the row whose presence is load-bearing, and
      // the failure mode is destroying live work — so this read does not get to
      // be eventually consistent.
      const pending = await dbWrite.appBlockPublishRequest.findFirst({
        where: { slug, status: 'pending' },
        select: { id: true },
      });
      if (pending) {
        result.skippedPending += 1;
        logPurge({ type: 'info', slug, outcome: 'skipped-pending', pendingId: pending.id });
        continue;
      }

      const outcome = await deleteReviewRepo(slug);
      if (outcome === 'deleted') result.deleted += 1;
      else result.alreadyGone += 1;
      logPurge({ type: 'info', slug, outcome });
    } catch (error) {
      result.failed += 1;
      logPurge({
        type: 'error',
        level: 'error',
        slug,
        outcome: 'failed',
        message: (error as Error)?.message,
      });
    }
  }

  // Advance the cursor past the whole batch, INCLUDING rows that failed or were
  // held back. Deliberate: this sweep must always make forward progress. Parking
  // the cursor on a permanently-failing slug would wedge ALL future purging on
  // one bad repo, and a purge miss costs storage, not safety — the actual
  // security control is that snapshots are private, not that they are deleted.
  // Failures are logged at error level with the slug so they stay actionable,
  // and a held-back slug re-enters the queue the next time it goes terminal.
  // Rows are ordered ascending and every row is < cutoff, so this can never
  // advance past something that was not yet due.
  const maxUpdatedAt = rows[rows.length - 1].updatedAt;
  await setCursor(maxUpdatedAt);

  return result;
}

/**
 * Cadence: hourly. The eligibility gate is 30 days, so cadence sets only how
 * quickly the backlog drains (batchSize per run), never whether something is
 * reclaimed on time.
 *
 * FAIL-OPEN: a janitor failure must never mark the runner failed or page. We
 * catch, log, and return a benign summary; the next tick retries.
 */
export const purgeReviewSnapshotsJob = createJob(
  'purge-review-snapshots',
  '20 * * * *',
  async () => {
    try {
      const result = await purgeExpiredReviewSnapshots();
      // Stay silent on a no-op run; only report when the sweep did something.
      if (result.scanned > 0) logPurge({ type: 'info', outcome: 'summary', ...result });
      return result;
    } catch (error) {
      logPurge({
        type: 'error',
        level: 'error',
        outcome: 'run-failed',
        message: (error as Error)?.message,
        stack: (error as Error)?.stack,
      });
      return {
        scanned: 0,
        candidates: 0,
        deleted: 0,
        alreadyGone: 0,
        skippedPending: 0,
        failed: 0,
        error: true as const,
      };
    }
  }
);
