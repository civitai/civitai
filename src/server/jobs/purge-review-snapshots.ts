import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { JobContext } from './job';
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
 * The status vocabulary is closed at the DB — `CHECK ("status" IN ('pending',
 * 'approved','rejected','withdrawn'))` — which is what lets the two sets below
 * be written as an exact partition rather than a best-effort list.
 *
 * Terminal statuses that make a slug's snapshot eligible for reclamation.
 *
 * 🔴 `approved` is deliberately NOT here. An approved app's snapshot is out of
 * scope for this sweep — approval is a different lifecycle with its own
 * artifacts, and reclaiming there is a separate decision. That exclusion is
 * ENFORCED by `SNAPSHOT_PROTECTING_STATUSES` below, not just by this list:
 * eligibility is per-ROW while the snapshot is per-SLUG, so a row's status
 * alone cannot decide whether the snapshot may go.
 */
export const PURGEABLE_TERMINAL_STATUSES = ['rejected', 'withdrawn'] as const;

/**
 * Statuses whose presence on a slug PROTECTS that slug's snapshot — the exact
 * complement of `PURGEABLE_TERMINAL_STATUSES` over the closed vocabulary, i.e.
 * "not terminal for the purposes of this sweep".
 *
 * `pending` — someone is mid-review and the snapshot is the thing under review.
 * `approved` — the snapshot belongs to a live app, which this sweep does not
 * touch by design (see above).
 */
export const SNAPSHOT_PROTECTING_STATUSES = ['pending', 'approved'] as const;

export type PurgeReviewSnapshotsResult = {
  /** Terminal rows examined this run. */
  scanned: number;
  /** Distinct slugs considered (rows dedupe to one delete attempt per slug). */
  candidates: number;
  /** Snapshots actually reclaimed. */
  deleted: number;
  /** Snapshots that were already gone — idempotent re-run, counted not failed. */
  alreadyGone: number;
  /** Slugs held back because a protecting request still owns the snapshot. */
  skippedProtected: number;
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
  opts: {
    now?: Date;
    batchSize?: number;
    /**
     * Cancellation hook from the job runner. The webhook releases this job's
     * Redis run-lock when its HTTP request closes, so without a cancel check a
     * long batch keeps deleting after the lock is gone and a re-trigger can run
     * beside it. Deletes are idempotent so the overlap is not destructive, but
     * checking makes the lock mean what it looks like it means.
     */
    jobContext?: Pick<JobContext, 'checkIfCanceled'>;
  } = {}
): Promise<PurgeReviewSnapshotsResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? REVIEW_SNAPSHOT_PURGE_BATCH_SIZE;
  const cutoff = new Date(now.getTime() - REVIEW_SNAPSHOT_PURGE_AFTER_MS);

  const result: PurgeReviewSnapshotsResult = {
    scanned: 0,
    candidates: 0,
    deleted: 0,
    alreadyGone: 0,
    skippedProtected: 0,
    failed: 0,
  };

  // Resumable cursor over the terminal-transition timestamp. `updatedAt` is the
  // best available "when did this row go terminal" signal: `reviewedAt` is NULL
  // for withdrawn rows (the DB's review-pair CHECK exempts them), so it cannot
  // be used as the sole ordering key.
  //
  // ⚠️ `updatedAt` is NOT frozen once a row goes terminal — Prisma's `@updatedAt`
  // bumps on any later write, and one such write exists today: the reject path
  // clears the request's deploy-state fields right after setting the terminal
  // status. Both directions are benign at this scale: a bump before the sweep
  // first sees the row only restarts its 30-day clock (that one lands seconds
  // later), and a bump after the cursor passed it re-presents the row for an
  // idempotent re-delete. What this is NOT robust against is a future BULK write
  // over terminal rows, which would silently reset every retention clock at
  // once. Keying on a frozen decision timestamp is the fix if that becomes real
  // — it changes which rows are eligible, so it is a deliberate follow-up, not
  // something to slip in here.
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
    // Checked OUTSIDE the per-slug try on purpose: that catch exists to absorb
    // one repo's failure and continue, and swallowing a cancellation there would
    // do the exact opposite of stopping.
    opts.jobContext?.checkIfCanceled();
    try {
      // 🔴 THE CORRECTNESS GATE. Snapshots are keyed per-slug and OVERWRITTEN on
      // every submit, and a terminal request does not reserve its slug — so the
      // repo a 40-day-old rejected row points at may today hold an entirely
      // different request's source, possibly a different owner's. The row that
      // made us eligible therefore cannot decide the delete on its own; only the
      // slug's CURRENT holder can.
      //
      // `SNAPSHOT_PROTECTING_STATUSES` is the complement of the purgeable set
      // over the closed status vocabulary, so "a protecting row exists for this
      // slug" is exactly "the snapshot is not in scope for reclamation right
      // now" — covering both a review in flight (`pending`) and a live app
      // (`approved`) — and we hold back.
      //
      // Read from the PRIMARY (`dbWrite`), not the replica: the row that must
      // block us can be seconds old (a developer resubmitting right now) while
      // the row that made us eligible is 30+ days old. A replica lagging by even
      // a moment would hide exactly the row whose presence is load-bearing, and
      // the failure mode is destroying live work — so this read does not get to
      // be eventually consistent.
      const protectedBy = await dbWrite.appBlockPublishRequest.findFirst({
        where: { slug, status: { in: [...SNAPSHOT_PROTECTING_STATUSES] } },
        select: { id: true, status: true },
      });
      if (protectedBy) {
        result.skippedProtected += 1;
        logPurge({
          type: 'info',
          slug,
          outcome: 'skipped-protected',
          protectedById: protectedBy.id,
          protectedByStatus: protectedBy.status,
        });
        continue;
      }

      const outcome = await deleteReviewRepo(slug);
      if (outcome === 'deleted') result.deleted += 1;
      else result.alreadyGone += 1;
      logPurge({ type: 'info', slug, outcome });

      // POST-DELETE RE-CHECK — the gate above cannot be perfectly tight, because
      // submit writes the snapshot BEFORE it inserts the row that protects it
      // (`ensureReviewRepo` + `commitFiles` run first, the `create` last). A
      // submission that begins between this slug's gate read and this delete is
      // therefore invisible to the gate. The window is one round-trip, and the
      // outcome is a live request whose snapshot is missing: the in-app diff
      // still renders (it reads object storage), but the review preview cannot
      // start. Re-reading here does not close the race — it makes it LOUD, so
      // the mod-facing failure has an explanation and the developer can simply
      // resubmit. Reordering the submit path so the row lands before the
      // snapshot push is the real fix; that is a user-facing write path and is
      // deliberately out of scope for this sweep.
      if (outcome === 'deleted') {
        const raced = await dbWrite.appBlockPublishRequest.findFirst({
          where: { slug, status: 'pending' },
          select: { id: true },
        });
        if (raced) {
          logPurge({
            type: 'error',
            level: 'error',
            slug,
            outcome: 'deleted-under-new-submission',
            pendingId: raced.id,
          });
        }
      }
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
  //
  // ACCEPTED LIMITATION: because the next run resumes with `gt`, a row sharing
  // the last row's exact `updatedAt` that fell outside this batch's `take` is
  // never revisited. The column is `timestamptz(6)` and the rows are
  // independent moderator/developer actions, so colliding at microsecond
  // resolution is vanishingly unlikely, and the cost if it happens is one
  // snapshot that is never reclaimed — storage, never a wrong delete. Accepted
  // rather than paid for with a composite `(updatedAt, id)` keyset cursor.
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
  async (jobContext) => {
    try {
      const result = await purgeExpiredReviewSnapshots({ jobContext });
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
        skippedProtected: 0,
        failed: 0,
        error: true as const,
      };
    }
  }
);
