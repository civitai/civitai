import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob, type JobContext } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { deleteImages, ingestImage } from '~/server/services/image.service';
import { imageIngestCronCounter, imageIngestCronQueueDepth } from '~/server/prom/client';
import { PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { getImageScanRetryLimit } from '~/server/services/image-scan-failure';
import { decreaseDate } from '~/utils/date-helpers';

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 9;

// Hard per-image backstop for a single submit. The orchestrator submit is already
// bounded per-attempt (createImageIngestionRequest, ~15s AbortSignal), but this also
// covers any other external await inside ingestImage (Redis flag read, prompt lookup,
// the scanJobs UPDATE) so one hung submit ties up a single concurrency slot rather
// than the whole run. A fired timeout just fails that image → it stays queued and is
// retried on a later run.
const INGEST_IMAGE_TIMEOUT_MS = 60 * 1000;

// Per-run wall-clock budget. Once exceeded we stop STARTING new submits so the run
// reaches its metric-recording + prune tail and returns cleanly, instead of being
// killed mid-send. A killed run recorded NOTHING (absent from job_duration /
// cron_total, both written at the end) and re-loaded the same oldest-1000 rows every
// run, so the backlog never drained. Images not reached this run stay in the JobQueue
// and are picked up next run.
//
// Worst case for a run is this budget + one INGEST_IMAGE_TIMEOUT_MS: when the deadline
// trips, up to INGEST_SUBMIT_CONCURRENCY submits are already in flight and must settle
// (bounded by the per-image backstop) before limitConcurrency resolves. That total
// MUST stay under the 300s job lock (lockExpiration in job.ts, also the 5-min cron
// cadence) — landing on 300s risks a DUPLICATE concurrent run, which is the exact
// scanner-flood / backlog-re-sweep mode we're fixing. 210s + 60s = 270s leaves a clean
// 30s margin.
const INGEST_RUN_BUDGET_MS = 3.5 * 60 * 1000;

// Concurrency for the per-image orchestrator submits. Each submit is bounded to ~15s
// (createImageIngestionRequest AbortSignal) and backstopped at INGEST_IMAGE_TIMEOUT_MS
// here, so a stalled submit occupies one slot, never the run. 20 is well above the old
// effective ~4 (4 chunks × in-chunk-sequential) for real throughput, yet bounded so a
// run can't dump more than 20 in-flight submits on the rating scanner at once (the
// per-run pull is already capped by IMAGE_SCANNING_MAX_PER_RUN).
const INGEST_SUBMIT_CONCURRENCY = 20;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ingestImage timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

type IngestImageRow = IngestImageInput & {
  scanRequestedAt: Date | null;
  ingestion: string;
  retryCount: number | null;
  /**
   * Reason-derived failure class stamped by the scan webhook
   * (`scanJobs.error.failureClass`), used to pick the Error retry ceiling.
   * Null for images that have never errored or errored before classification shipped.
   */
  failureClass: string | null;
  /**
   * True when the image is connected to an already-Published Article (via
   * ImageConnection) and therefore represents backfill work from the article
   * content-image migration. These are routed through the low-priority
   * orchestrator lane so they don't starve live user uploads.
   */
  isBackfill: boolean;
  /**
   * First-upload timestamp. Used ONLY as the age-out clock for never-returning
   * Pending scans: unlike `scanRequestedAt` (reset to `now` on every re-send by
   * `ingestImage`), `createdAt` is immutable, so it's the one signal a re-drive
   * loop can't keep pushing into the future. See the Pending age-out below.
   */
  createdAt: Date;
};

export const ingestImages = createJob('ingest-images', '*/5 * * * *', async (ctx) => {
  const now = new Date();
  const deadline = now.getTime() + INGEST_RUN_BUDGET_MS;

  // Bound how many queued images we pull (and therefore can submit) per run. The
  // media-rating scanner sustains only a limited throughput; pulling the whole
  // queue at once (previously a hardcoded 10,000) can dump ~5x what the scanner
  // can absorb, so bulk rating jobs expire before they run, workflows fail, and
  // images flip to Error — which the cron then re-queues, amplifying the flood
  // into a congestion collapse. Since every downstream step (filtering, the
  // submission fan-out, and the JobQueue cleanup) is derived only from the rows
  // pulled here, capping this pull caps per-run submissions AND leaves the rows
  // we did NOT pull this run untouched in the queue. Oldest-first (createdAt asc)
  // keeps draining fair, so a backlog drains gradually across runs. New user
  // uploads scan directly via ingestImage on creation and are unaffected by this
  // cap — this cron is only the retry/backfill path.
  const maxPerRun = env.IMAGE_SCANNING_MAX_PER_RUN;

  // Pull from JobQueue instead of scanning Image table with partial indexes
  const jobQueue = await dbRead.jobQueue.findMany({
    where: { type: JobQueueType.ImageScan, entityType: EntityType.Image },
    take: maxPerRun,
    orderBy: { createdAt: 'asc' },
  });

  if (!jobQueue.length) {
    imageIngestCronQueueDepth.set(0);
    console.log('No images in queue');
    return { processed: 0 };
  }

  imageIngestCronQueueDepth.set(jobQueue.length);
  const imageIds = jobQueue.map((j) => j.entityId);
  console.log(`Found ${imageIds.length} images in queue`);

  // Fetch full image data by IDs (fast primary key lookup).
  // `isBackfill` flags images connected to already-Published Articles via
  // ImageConnection — these come from the legacy-article-content migration and
  // should scan via the low-priority orchestrator lane. EXISTS uses the
  // ImageConnection composite PK (imageId, entityType, entityId) for an
  // index-only seek per image.
  const images =
    (await dbWrite.$queryRaw<IngestImageRow[]>`
    SELECT i.id, i.url, i.type, i.width, i.height, i.meta->>'prompt' as prompt,
           i."scanRequestedAt", i."createdAt", i.ingestion,
           (i."scanJobs"->>'retryCount')::int as "retryCount",
           i."scanJobs"->'error'->>'failureClass' as "failureClass",
           EXISTS (
             SELECT 1 FROM "ImageConnection" ic
             JOIN "Article" a ON a.id = ic."entityId"
             WHERE ic."imageId" = i.id
               AND ic."entityType" = 'Article'
               AND a.status = 'Published'::"ArticleStatus"
           ) AS "isBackfill"
    FROM "Image" i
    WHERE i.id = ANY(${imageIds})
  `) ?? [];

  // Filter based on status and retry logic
  const rescanDate = decreaseDate(now, env.IMAGE_SCANNING_RETRY_DELAY, 'minutes');
  const errorRetryDate = decreaseDate(now, IMAGE_SCANNING_ERROR_DELAY, 'minutes').getTime();

  const pendingImages = images.filter(
    (img) =>
      img.ingestion === 'Pending' && (!img.scanRequestedAt || img.scanRequestedAt <= rescanDate)
  );

  // Age-out safety net for never-returning Pending scans.
  //
  // A scan verdict arrives via the fire-and-forget /image-scan-result webhook,
  // which flips ingestion Pending -> Scanned/Blocked/Error. A fraction of scans
  // never call back — a dropped callback (workflow succeeded, POST lost) or a
  // stuck/unassigned workflow that never finishes — and NEITHER civitai nor the
  // orchestrator has any timeout on that path. Those images stay ingestion
  // 'Pending' forever and this cron re-drives them every cooldown with no ceiling.
  //
  // The age-out clock MUST be `createdAt`, NOT `scanRequestedAt`: `ingestImage`
  // stamps `scanRequestedAt = now` on every (re-)send, so a "Pending too long by
  // scanRequestedAt" test resets each run and can never fire. `createdAt` is the
  // first-upload time (~first scan request, since user uploads scan directly via
  // ingestImage on creation) and is never rewritten, so it's the one signal the
  // re-drive loop can't push forward.
  //
  // Scope: user uploads only (`!isBackfill`). Article-content backfill images are
  // legitimately old (createdAt months back) and drain slowly through the
  // low-priority lane — an age-out keyed on createdAt would wrongly terminalize
  // the entire backfill on its first pass, so it is excluded outright.
  //
  // Threshold is env-tuned and conservative: it must exceed the wall-time of any
  // legitimately in-flight scan so a healthy scan is never cut off. A too-long
  // Pending image is flipped to Error (below, in the prod block), which routes it
  // into the EXISTING capped Error-retry machinery — it gets a bounded number of
  // real retries and then terminalizes, instead of being Pending forever.
  const pendingTimeoutDate = decreaseDate(now, env.IMAGE_SCANNING_PENDING_TIMEOUT, 'minutes');
  const agedOutPendingIds = images
    .filter(
      (img) => img.ingestion === 'Pending' && !img.isBackfill && img.createdAt <= pendingTimeoutDate
    )
    .map((img) => img.id);
  const agedOutPendingSet = new Set(agedOutPendingIds);

  // Split pending into backfill (article-connected, low-priority) and user
  // uploads (default high-priority). Backfill work shouldn't starve live
  // uploads. Published-article connection is determined by the isBackfill
  // flag populated in the image SELECT above. Aged-out user uploads are excluded
  // from the send fan-out: they are terminalized to Error this run, so re-sending
  // them as Pending would be wasted work (and re-stamp scanRequestedAt). They
  // still stay in the JobQueue via `processedIds` below (they remain in
  // `pendingImages`), so next run they are picked up through the Error path.
  const pendingBackfill = pendingImages.filter((img) => img.isBackfill);
  const pendingUserUploads = pendingImages.filter(
    (img) => !img.isBackfill && !agedOutPendingSet.has(img.id)
  );

  // Rescan mirrors Pending/Error: only re-send once the retry delay has elapsed
  // (cooldown via scanRequestedAt) and while still under the retry cap. Without
  // the cooldown, every Rescan image was re-submitted on every run — the
  // low-priority scanner-queue flood.
  const rescanImages = images.filter(
    (img) =>
      img.ingestion === 'Rescan' &&
      (!img.scanRequestedAt || img.scanRequestedAt <= rescanDate) &&
      Number(img.retryCount ?? 0) < IMAGE_SCANNING_RETRY_LIMIT
  );

  // Error retries use a reason-aware ceiling: transient infra churn (Siglip
  // container instability, 5xx, timeouts, expiry) keeps retrying under a higher
  // bounded cap; permanent (unscannable media) gives up almost immediately;
  // unknown keeps the historical 9-cap. retryCount always increments, so the cap
  // is a hard backstop against re-flooding the scanner.
  const errorImages = images.filter(
    (img) =>
      img.ingestion === 'Error' &&
      img.scanRequestedAt &&
      new Date(img.scanRequestedAt).getTime() <= errorRetryDate &&
      Number(img.retryCount ?? 0) < getImageScanRetryLimit(img.failureClass)
  );

  // Categorize images for proper queue cleanup:
  // 1. Images we're about to process - remove from queue
  const processedIds = new Set([
    ...pendingImages.map((img) => img.id),
    ...rescanImages.map((img) => img.id),
    ...errorImages.map((img) => img.id),
  ]);

  // 2. Images still in scannable status but waiting for retry delay - KEEP in queue
  const waitingForRetryIds = new Set(
    images
      .filter((img) => {
        // Pending but recently scanned - waiting for retry delay
        if (
          img.ingestion === 'Pending' &&
          img.scanRequestedAt &&
          img.scanRequestedAt > rescanDate
        ) {
          return true;
        }
        // Rescan waiting for the retry delay (and still under the retry cap) - KEEP.
        // Must mirror the rescanImages cooldown above, otherwise a cooled-down
        // Rescan image is neither processed nor waiting and gets wrongly pruned.
        if (img.ingestion === 'Rescan') {
          const waitingForDelay = !!img.scanRequestedAt && img.scanRequestedAt > rescanDate;
          const underRetryLimit = Number(img.retryCount ?? 0) < IMAGE_SCANNING_RETRY_LIMIT;
          return waitingForDelay && underRetryLimit;
        }
        // Error but waiting for retry delay or under retry limit. Mirror the
        // reason-aware ceiling used by errorImages above.
        if (img.ingestion === 'Error') {
          const waitingForDelay =
            img.scanRequestedAt && new Date(img.scanRequestedAt).getTime() > errorRetryDate;
          const underRetryLimit =
            Number(img.retryCount ?? 0) < getImageScanRetryLimit(img.failureClass);
          return waitingForDelay && underRetryLimit;
        }
        return false;
      })
      .map((img) => img.id)
  );

  // 3. Images no longer in scannable status (Scanned, Blocked, etc.) or exceeded retry limit - remove
  const imageIdSet = new Set(images.map((img) => img.id));
  const staleIds = imageIds.filter((id) => {
    // Image was deleted or not found
    if (!imageIdSet.has(id)) return true;
    // Image is being processed
    if (processedIds.has(id)) return false;
    // Image is waiting for retry
    if (waitingForRetryIds.has(id)) return false;
    // Otherwise it's stale (status changed or exceeded retry limit)
    return true;
  });

  console.log({
    pendingImages: pendingImages.length,
    pendingUserUploads: pendingUserUploads.length,
    pendingBackfill: pendingBackfill.length,
    agedOutPending: agedOutPendingIds.length,
    rescanImages: rescanImages.length,
    errorImages: errorImages.length,
    waitingForRetry: waitingForRetryIds.size,
    staleIds: staleIds.length,
  });

  if (!isProd) return;

  // Prune stale rows (status changed to non-scannable or retry limit exceeded)
  // BEFORE the send loop, not after: the sends fan out hundreds–thousands of
  // orchestrator calls and can be slow or error out, and gating the prune behind
  // them lets stale rows accumulate faster than they clear — the queue bloats,
  // runs get heavier, and the prune keeps not happening. The stale set is derived
  // purely from the rows already loaded above, so it's safe to delete first.
  // Processed items intentionally stay in the queue and become stale next run only
  // if their scan never completes, which preserves retry-on-silent-failure.
  const idsToRemove = [...staleIds];
  if (idsToRemove.length > 0) {
    await dbWrite.$executeRaw`
      DELETE FROM "JobQueue"
      WHERE type = ${JobQueueType.ImageScan}::"JobQueueType"
        AND "entityType" = ${EntityType.Image}::"EntityType"
        AND "entityId" = ANY(${idsToRemove})
    `;
  }

  // A still-`Rescan` image that's now stale has exhausted its retry cap without
  // the scan ever returning. Terminalize it to `Error` so it stops reading as
  // in-flight system-wide — otherwise article scan-status keeps it in the
  // pending bucket and the panel polls a never-settling row forever.
  const staleIdSet = new Set(staleIds);
  const exhaustedRescanIds = images
    .filter((img) => img.ingestion === 'Rescan' && staleIdSet.has(img.id))
    .map((img) => img.id);
  if (exhaustedRescanIds.length > 0) {
    await dbWrite.$executeRaw`
      UPDATE "Image"
      SET ingestion = 'Error'::"ImageIngestionStatus"
      WHERE id = ANY(${exhaustedRescanIds})
        AND ingestion = 'Rescan'::"ImageIngestionStatus"
    `;
  }

  // Terminalize never-returning Pending scans (see the age-out rationale above).
  // Flip the too-long-Pending user uploads to Error so they leave the Pending
  // bucket and enter the capped Error-retry path. The id set is derived purely
  // from the already-loaded rows and this runs before the send fan-out (mirrors
  // the prune-before-send and exhaustedRescan ordering). The `AND ingestion =
  // 'Pending'` guard makes the flip a no-op if a real verdict landed between the
  // SELECT and here — a concurrent callback always wins, we never clobber a
  // Scanned/Blocked result. These ids stay in the JobQueue (they're in
  // `pendingImages` -> `processedIds`, so not pruned), so next run they are
  // re-pulled and handled as Error.
  if (agedOutPendingIds.length > 0) {
    await dbWrite.$executeRaw`
      UPDATE "Image"
      SET ingestion = 'Error'::"ImageIngestionStatus"
      WHERE id = ANY(${agedOutPendingIds})
        AND ingestion = 'Pending'::"ImageIngestionStatus"
    `;
  }

  // Lanes are sent in priority order (user uploads first, error last). Each honors
  // the shared run deadline + cancellation and stops starting new submits once the
  // budget is spent, so the run always reaches the metric/return tail below.
  const userLane = await sendImagesForScanBulk(pendingUserUploads, { deadline, ctx });
  const backfillLane = await sendImagesForScanBulk(pendingBackfill, {
    lowPriority: true,
    deadline,
    ctx,
  });
  const rescanLane = await sendImagesForScanBulk(rescanImages, {
    lowPriority: true,
    deadline,
    ctx,
  });
  const errorLane = await sendImagesForScanBulk(errorImages, { lowPriority: true, deadline, ctx });

  const sentUserPendingIds = userLane.sent;
  const sentBackfillIds = backfillLane.sent;
  const sentRescanIds = rescanLane.sent;
  const sentErrorIds = errorLane.sent;

  const totalSent =
    sentUserPendingIds.length + sentBackfillIds.length + sentRescanIds.length + sentErrorIds.length;

  imageIngestCronCounter.inc({ bucket: 'sentUserPending' }, sentUserPendingIds.length);
  imageIngestCronCounter.inc({ bucket: 'sentBackfill' }, sentBackfillIds.length);
  imageIngestCronCounter.inc({ bucket: 'sentRescan' }, sentRescanIds.length);
  imageIngestCronCounter.inc({ bucket: 'sentError' }, sentErrorIds.length);
  imageIngestCronCounter.inc({ bucket: 'waitingForRetry' }, waitingForRetryIds.size);
  imageIngestCronCounter.inc({ bucket: 'staleRemoved' }, staleIds.length);
  imageIngestCronCounter.inc({ bucket: 'agedOutPending' }, agedOutPendingIds.length);

  // Failed sends = images whose submit was attempted and returned/threw failure,
  // across every lane. Images not reached this run (budget/cancel) are neither sent
  // nor failed — they stay queued — so we count only genuine failures.
  const failedSends =
    userLane.failed.length +
    backfillLane.failed.length +
    rescanLane.failed.length +
    errorLane.failed.length;

  logToAxiom(
    {
      name: 'image-ingestion',
      type: 'job-summary',
      sent: totalSent,
      sentUserPending: sentUserPendingIds.length,
      sentBackfill: sentBackfillIds.length,
      sentRescan: sentRescanIds.length,
      sentError: sentErrorIds.length,
      pending: pendingImages.length,
      rescan: rescanImages.length,
      error: errorImages.length,
      agedOutPending: agedOutPendingIds.length,
      waitingForRetry: waitingForRetryIds.size,
      staleRemoved: staleIds.length,
      failedSends,
    },
    'webhooks'
  ).catch(() => null);

  if (failedSends > 0) {
    logToAxiom(
      {
        name: 'image-ingestion',
        type: 'error',
        message: 'image scan sends failed',
        failureType: 'send-fail',
        failedSends,
      },
      'webhooks'
    ).catch(() => null);
  }

  return {
    sent: totalSent,
    sentUserPending: sentUserPendingIds.length,
    sentBackfill: sentBackfillIds.length,
    sentRescan: sentRescanIds.length,
    sentError: sentErrorIds.length,
    agedOutPending: agedOutPendingIds.length,
    waitingForRetry: waitingForRetryIds.size,
    staleRemoved: staleIds.length,
    failedSends,
  };
});

export async function sendImagesForScanBulk(
  images: IngestImageInput[],
  options?: { lowPriority?: boolean; deadline?: number; ctx?: JobContext }
): Promise<{ sent: number[]; failed: number[] }> {
  if (!images.length) return { sent: [], failed: [] };
  const { lowPriority, deadline, ctx } = options ?? {};

  const sent: number[] = [];
  const failed: number[] = [];

  // One submit per image at bounded concurrency (no in-chunk sequential loop, no
  // in-batch retry). A single pass per run: a failed/timed-out submit leaves the
  // image Error/Pending, so it is retried on the NEXT cron run after the cooldown —
  // in-run resends just tripled the time under failure and burned the run budget.
  const tasks = images.map((image) => async () => {
    // Out of budget or canceled/superseded: don't start this submit. The image is
    // neither sent nor failed — it stays queued and is retried next run.
    if (deadline && Date.now() >= deadline) return;
    if (ctx?.status === 'canceled') return;

    let imageSuccess = false;
    try {
      imageSuccess = await withTimeout(
        ingestImage({ image, lowPriority }),
        INGEST_IMAGE_TIMEOUT_MS
      );
    } catch {
      imageSuccess = false;
    }
    if (imageSuccess) sent.push(image.id);
    else failed.push(image.id);
  });

  await limitConcurrency(tasks, INGEST_SUBMIT_CONCURRENCY);
  if (failed.length > 0) console.log('Failed sends:', failed.length);

  return { sent, failed };
}

const BLOCKED_IMAGE_RETENTION_DAYS = 7;
// Ceiling on the CSAM hold below, measured from the REPORT, not from the block: the
// send/archive pipeline has no retry limit and no dead-letter, so a report nobody finishes
// would otherwise hold a user's blocked media forever. Clocking it from the block instead
// would silently shrink each report's budget by however old the block already was.
const CSAM_HOLD_MAX_DAYS = 30;

export const removeBlockedImages = createJob(
  'remove-blocked-images',
  '0 * * * *',
  async () => {
    // dbWrite because a report created within replica lag would otherwise be invisible here
    // and its evidence purged in this same run.
    const heldUsers = await dbWrite.$queryRaw<{ userId: number; oldestReport: Date }[]>`
      SELECT "userId", MIN("createdAt") AS "oldestReport"
      FROM "CsamReport"
      WHERE "userId" IS NOT NULL
        AND ("reportSentAt" IS NULL OR "archivedAt" IS NULL)
      GROUP BY "userId"
    `;
    const holdCutoff = decreaseDate(new Date(), CSAM_HOLD_MAX_DAYS, 'days');
    const activeUserIds = heldUsers.filter((u) => u.oldestReport > holdCutoff).map((u) => u.userId);
    const expiredUserIds = heldUsers
      .filter((u) => u.oldestReport <= holdCutoff)
      .map((u) => u.userId);

    // Excluded from the batch rather than filtered out after: held rows stay queued forever, so
    // in an oldest-first window they would occupy the whole batch every run, stalling deletion
    // site-wide for every other user.
    const heldActive = activeUserIds.length
      ? (
          await dbRead.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Image"
        WHERE "userId" = ANY(${activeUserIds})
          AND ingestion = 'Blocked'::"ImageIngestionStatus"
      `
        ).map((x) => x.id)
      : [];

    const jobQueue = await dbRead.jobQueue.findMany({
      where: {
        type: JobQueueType.BlockedImageDelete,
        entityType: EntityType.Image,
        ...(heldActive.length ? { entityId: { notIn: heldActive } } : {}),
      },
      take: 15000,
      orderBy: { createdAt: 'asc' },
    });

    if (!jobQueue.length) {
      console.log('No blocked images in queue', { csamHeld: heldActive.length });
      return { processed: 0, csamHeld: heldActive.length };
    }

    const imageIds = jobQueue.map((j) => j.entityId);
    console.log(`Found ${imageIds.length} blocked images in queue`);

    // The queue row is written by trg_blocked_image_delete_queue on the transition into
    // Blocked, so its createdAt is the block time. Image.createdAt would start the clock at
    // upload, making anything blocked more than a week after upload deletable on the next run.
    const blockedAt = new Map(jobQueue.map((j) => [j.entityId, j.createdAt]));
    const cutoff = decreaseDate(new Date(), BLOCKED_IMAGE_RETENTION_DAYS, 'days');
    // `fromAccountDeletion` separates the two populations that arrive here wearing the same
    // `blockedFor`. See the retraction split below for why that matters; `PRIOR_INGESTION_KEY`
    // is written by `remove-deleted-user-images` and by nothing else.
    const images = await dbRead.$queryRaw<
      { id: number; userId: number; blockedFor: string | null; fromAccountDeletion: boolean }[]
    >`
    SELECT id, "userId", "blockedFor",
           ("metadata" -> ${PRIOR_INGESTION_KEY}) IS NOT NULL AS "fromAccountDeletion"
    FROM "Image"
    WHERE id = ANY(${imageIds})
      AND ingestion = 'Blocked'::"ImageIngestionStatus"
  `;
    const imageById = new Map(images.map((img) => [img.id, img]));

    const imagesToDelete = images.filter((img) => {
      // AiNotVerified is unblocked by a separate re-verification path, never purged here.
      if (img.blockedFor === 'AiNotVerified') return false;

      const queuedAt = blockedAt.get(img.id);
      return !!queuedAt && queuedAt <= cutoff;
    });

    // Queued but no longer purgeable: the image is gone, left Blocked, or is AiNotVerified.
    const deleteReadyIds = new Set(imagesToDelete.map((img) => img.id));
    const staleIds = imageIds.filter((id) => {
      const img = imageById.get(id);
      if (!img) return true;
      return img.blockedFor === 'AiNotVerified';
    });

    const staleIdSet = new Set(staleIds);
    const waitingIds = imageIds.filter((id) => {
      if (!imageById.has(id)) return false;
      if (deleteReadyIds.has(id)) return false;
      if (staleIdSet.has(id)) return false;
      return true;
    });

    // Only the images actually being destroyed this run, so the alert can't over-report an
    // expired hold whose images fell outside the batch or turned out to be stale.
    const expiredUserIdSet = new Set(expiredUserIds);
    const holdExpiredDeletions = imagesToDelete.filter((img) => expiredUserIdSet.has(img.userId));

    console.log({
      imagesToDelete: imagesToDelete.length,
      waitingForRetention: waitingIds.length,
      csamHeld: heldActive.length,
      csamHoldExpired: holdExpiredDeletions.length,
      staleIds: staleIds.length,
    });

    if (!isProd) return { imagesToDelete: imagesToDelete.length };

    if (!env.DATABASE_IS_PROD) return { imagesToDelete: 0 };

    // Emitted immediately before the delete and never truncated: once these rows and their
    // queue entries are gone this log is the only record that the evidence existed.
    if (holdExpiredDeletions.length) {
      logToAxiom({
        name: 'remove-blocked-images',
        type: 'error',
        subType: 'csam-hold-expired',
        message: `CSAM report older than ${CSAM_HOLD_MAX_DAYS} days; purging its evidence anyway`,
        userIds: [...new Set(holdExpiredDeletions.map((x) => x.userId))],
        imageIds: holdExpiredDeletions.map((x) => x.id),
        count: holdExpiredDeletions.length,
      });
    }

    // Delete images that are past retention period.
    //
    // 🔴 THE ONE FLOW THAT RETRACTS — but NOT every image it deletes. `retractPublicBlobs` asks
    // the image-cache service to destroy the shared stored object, not just this image's derived
    // variants: the full-resolution original stops existing.
    //
    // This job reads a QUEUE, so what reaches this line is decided by that queue's WRITERS, not by
    // this job's own callers. `trg_blocked_image_delete_queue` enqueues every row that ends up
    // `ingestion = 'Blocked'` with a `blockedFor` other than 'AiNotVerified', whatever put it
    // there. Those writers are `handleBlockImages`, the moderator app's own `blockImage`, the CSAM
    // branch of `report.service`, and the scan webhook's block outcome — all takedowns — plus ONE
    // that is not: `remove-deleted-user-images`, which hides the images of a user who deleted
    // their OWN account and chose the 7-day grace option, and enqueues them here explicitly via
    // `queueBlockedImagesForDelete` as well. It writes `blockedFor = 'moderated'`, exactly what a
    // moderator block writes, so `blockedFor` cannot tell the two apart — that is stated at
    // `PRIOR_INGESTION_KEY`. Nothing is moderated in that case and it must not reach another
    // owner's bytes, so the split below keys on the metadata marker the grace pass writes and no
    // other writer does. Both populations are still hard-deleted here; only the retraction differs.
    //
    // No other caller of `deleteImages` passes the option at all: an ordinary user deleting their
    // own picture, a replaced image being reaped, an account being drained in `immediate` mode and
    // the moderator bulk endpoint all keep today's variant-only invalidation.
    //
    // 🔴 KNOWN AND ACCEPTED COLLATERAL, documented here because it is not discoverable later.
    // The stored object is content-addressed, so it is shared by every BYTE-IDENTICAL image of
    // EVERY owner. Retracting it removes their original too, while their database rows survive
    // and go on serving a broken image — the orphaned-row symptom, deliberately reintroduced.
    // Accepted because a bit-identical copy of content that must not exist is the same content,
    // and a takedown that leaves copies serving is not a takedown. It is NOT fixed here: the app
    // stores no content-hash key per image, and `pHash` is a PERCEPTUAL hash — a similarity
    // signal, not a byte-identity key — so those rows cannot be enumerated from this codebase at
    // all. Building that fan-out is separate work; do not infer from this comment that it exists.
    // The `image-blob-retraction-requested` log line in `deleteImageFromS3` is the only trail.
    //
    // The marker is read as "did NOT come from a takedown", so a row whose marker is missing —
    // including one this query could not classify — falls into the retracting set, which is the
    // pre-existing behaviour rather than a silent loss of the capability.
    //
    // Known one-way inaccuracy, and it errs toward keeping the bytes: an image already carrying
    // the marker that a moderator then blocks keeps it, because no block path clears the marker,
    // so that takedown gets no retraction and behaves exactly as it did before this option
    // existed. `unblockAccountDeletionImages` (the restore path) is the only writer that removes
    // it. The opposite mistake — a takedown misread as an account deletion — needs the marker to
    // be written onto a moderated image, and `remove-deleted-user-images` is its only writer:
    // both of its branches are gated on the owner's `deletedAt` being set.
    const takedowns = imagesToDelete.filter((img) => !img.fromAccountDeletion).map((x) => x.id);
    const accountDeletions = imagesToDelete
      .filter((img) => img.fromAccountDeletion)
      .map((x) => x.id);
    if (takedowns.length > 0) {
      await deleteImages(takedowns, true, { retractPublicBlobs: true });
    }
    if (accountDeletions.length > 0) {
      await deleteImages(accountDeletions, true);
    }

    // Remove processed and stale entries from queue
    const idsToRemove = [...imagesToDelete.map((x) => x.id), ...staleIds];
    if (idsToRemove.length > 0) {
      await dbWrite.$executeRaw`
      DELETE FROM "JobQueue"
      WHERE type = ${JobQueueType.BlockedImageDelete}::"JobQueueType"
        AND "entityType" = ${EntityType.Image}::"EntityType"
        AND "entityId" = ANY(${idsToRemove})
    `;
    }

    return {
      deleted: imagesToDelete.length,
      // Reported separately so the two populations are legible in the job's own output: the
      // second number is deletions that deliberately left the shared stored object alone.
      retracted: takedowns.length,
      accountDeletionDeleted: accountDeletions.length,
      staleRemoved: staleIds.length,
      waitingForRetention: waitingIds.length,
      csamHeld: heldActive.length,
      csamHoldExpired: holdExpiredDeletions.length,
    };
  },
  // Deleting 15k images per run can exceed the 5-min default lock; a second pod
  // grabbing the lock mid-run would double-delete and hit S3/DB twice.
  { lockExpiration: 20 * 60 }
);
