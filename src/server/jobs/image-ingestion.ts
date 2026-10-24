import { Prisma } from '@prisma/client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { MODERATOR_TAKEDOWN_ACTIVITIES } from '~/server/common/moderator-takedown-activities';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob, type JobContext } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { deleteImages, ingestImage } from '~/server/services/image.service';
import { imageIngestCronCounter, imageIngestCronQueueDepth } from '~/server/prom/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { getImageScanRetryLimit } from '~/server/services/image-scan-failure';
import {
  legalHoldUserIdsSql,
  PLACEHOLDER_OWNER_ID,
  userUnderLegalHoldSql,
} from '~/server/utils/legal-hold';
import { accountHoldSql, holdMarkerViewExists } from '~/server/services/legal-hold.service';
import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import { decreaseDate } from '~/utils/date-helpers';
import {
  appealTrainingHeld,
  isAppealTrainingConfigured,
} from '~/server/jobs/appeal-decision-records';

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 9;

// Minutes a just-created image counts as "submit in flight" (see the double-submit
// note below). Must stay above the upload-path submit's own ceiling or the window it
// closes reopens; overshooting costs one cron tick of delay for an image whose submit
// died without writing the row at all.
const SUBMIT_IN_FLIGHT_GRACE = 2;

// Hours a Pending upload that keeps getting 429s is spared the age-out to Error.
const RATE_LIMIT_AGE_OUT_GRACE_HOURS = 6;

// Hard per-image backstop. The orchestrator submit is bounded per attempt (~15s), but the
// Flipt flag read before it and the scanJobs UPDATE after it are not, so this keeps one hung
// image to one concurrency slot. A timed-out image stays queued for a later run.
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
   * When its current run of 429 submits began; null unless the last submit was a 429.
   * A successful submit clears `scanJobs.error`, and with it this.
   */
  rateLimitedSince: Date | null;
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
           CASE WHEN i."scanJobs"->'error'->>'responseStatus' = '429'
             THEN (i."scanJobs"->'error'->>'firstRateLimitedAt')::timestamptz
           END as "rateLimitedSince",
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

  // A NULL `scanRequestedAt` does not yet mean "never submitted". The Image INSERT
  // trigger queues a new image immediately, but `ingestImage` stamps
  // `scanRequestedAt` only once its upload-path submit returns — up to ~50s later
  // (3 attempts x the 15s per-attempt abort). A run landing inside that window reads
  // the NULL as eligible and submits a SECOND workflow for the same image. Measured
  // 2026-09-18: of 41,865 images scanned in 12h, 166 had two workflows, and 161 of
  // those were created within 30s of a cron tick (uniform baseline: 9.8%).
  const submitInFlightDate = decreaseDate(now, SUBMIT_IN_FLIGHT_GRACE, 'minutes');
  const isSubmitInFlight = (img: IngestImageRow) =>
    img.ingestion === 'Pending' && !img.scanRequestedAt && img.createdAt > submitInFlightDate;

  const pendingImages = images.filter(
    (img) =>
      img.ingestion === 'Pending' &&
      !isSubmitInFlight(img) &&
      (!img.scanRequestedAt || img.scanRequestedAt <= rescanDate)
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
  //
  // A rate-limited upload is exempt: it is old because the orchestrator told us to wait,
  // not because a scan went missing, and it keeps being re-sent as Pending. Only for
  // RATE_LIMIT_AGE_OUT_GRACE_HOURS, so a limit that never lifts still surfaces as Error and
  // a long storm can't hold the oldest-first window forever.
  const pendingTimeoutDate = decreaseDate(now, env.IMAGE_SCANNING_PENDING_TIMEOUT, 'minutes');
  const rateLimitGraceDate = decreaseDate(now, RATE_LIMIT_AGE_OUT_GRACE_HOURS, 'hours');
  const isRateLimitExempt = (img: IngestImageRow) =>
    !!img.rateLimitedSince && img.rateLimitedSince > rateLimitGraceDate;
  const agedOutPendingIds = images
    .filter(
      (img) =>
        img.ingestion === 'Pending' &&
        !img.isBackfill &&
        !isRateLimitExempt(img) &&
        img.createdAt <= pendingTimeoutDate
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
  // unknown keeps the historical 9-cap. retryCount increments on every failed attempt
  // (not on a 429), so the cap is a hard backstop against re-flooding the scanner.
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
        // Skipped this run only because its first submit may still be in flight. It is
        // neither processed nor waiting on a cooldown, so without this it prunes as
        // stale — and if that submit died silently, nothing would ever re-drive it.
        if (isSubmitInFlight(img)) return true;
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

  const submitInFlightCount = images.filter(isSubmitInFlight).length;

  console.log({
    pendingImages: pendingImages.length,
    submitInFlight: submitInFlightCount,
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
  imageIngestCronCounter.inc({ bucket: 'submitInFlight' }, submitInFlightCount);

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
      submitInFlight: submitInFlightCount,
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
    submitInFlight: submitInFlightCount,
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

export { MODERATOR_TAKEDOWN_ACTIVITIES };

/**
 * The Blocked images of accounts under an account hold, read over the owners those holds can name:
 * one with a CSAM review flag, a CSAM block, or an image a report lists. The owners are read first
 * and materialized: as an IN subquery the planner misjudges how many there are and hash-joins every
 * Blocked image.
 */
export const accountHeldBlockedImagesSql = Prisma.sql`
  WITH owners AS MATERIALIZED (
    SELECT c."userId" FROM (
      SELECT "userId" FROM "Image" WHERE "needsReview" = 'csam'
      UNION
      SELECT "userId" FROM "Image" WHERE "blockedFor" = 'CSAM'
      UNION
      SELECT ri."userId"
      FROM "CsamReport" rr
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rr.images) = 'array' THEN rr.images ELSE '[]'::jsonb END
      ) re
      JOIN "Image" ri
        ON ri.id = CASE WHEN (re ->> 'id') ~ '^[0-9]{1,18}$' THEN (re ->> 'id')::bigint END
    ) c
    WHERE ${accountHoldSql(Prisma.raw('c."userId"'), true)}
  )
  SELECT i.id FROM "Image" i
  WHERE i.ingestion = 'Blocked'::"ImageIngestionStatus"
    AND i."userId" = ANY (ARRAY(SELECT "userId" FROM owners))
`;

/**
 * The job's holds, re-checked by the DELETE itself. They are read once at the start of a run that
 * can take its full lock to finish, so a hold placed mid-run would otherwise not stop it. Only valid
 * on a statement over an unaliased "Image".
 */
export function purgeHoldGuard({ holdForTrainingCopy }: { holdForTrainingCopy: boolean }) {
  return Prisma.sql`
    "Image".ingestion = 'Blocked'::"ImageIngestionStatus"
    AND "Image"."needsReview" IS DISTINCT FROM 'appeal'
    -- Read off the row itself, so a flag committed while this DELETE runs still holds the image.
    AND "Image"."needsReview" IS DISTINCT FROM 'csam'
    AND NOT ${userUnderLegalHoldSql(Prisma.raw('"Image"."userId"'))}
    AND NOT ${accountHoldSql(Prisma.raw('"Image"."userId"'), true)}
    ${
      holdForTrainingCopy
        ? Prisma.sql`AND NOT ${appealTrainingHeld(Prisma.raw('"Image"'))}`
        : Prisma.empty
    }
  `;
}

export const removeBlockedImages = createJob(
  'remove-blocked-images',
  '0 * * * *',
  async () => {
    const startedAt = Date.now();
    // The run's counts, in Axiom: the job runner logs only that a run succeeded.
    const finished = <T extends Record<string, number>>(summary: T) => {
      logToAxiom({
        name: 'remove-blocked-images',
        type: 'info',
        message: 'finished',
        ...summary,
        durationMs: Date.now() - startedAt,
      }).catch(() => undefined);
      return summary;
    };
    const cutoff = decreaseDate(new Date(), BLOCKED_IMAGE_RETENTION_DAYS, 'days');

    // Fails closed: a run that cannot read the legal holds deletes nothing.
    let heldActive: number[];
    try {
      // dbWrite because a report created within replica lag would otherwise be invisible here
      // and its evidence purged in this same run.
      const heldUsers = await dbWrite.$queryRaw<{ userId: string }[]>(legalHoldUserIdsSql);
      const heldUserIds = [
        PLACEHOLDER_OWNER_ID,
        ...heldUsers.map((u) => Number(u.userId)).filter(Number.isSafeInteger),
      ];

      // Excluded from the batch rather than filtered out after: held rows stay queued forever, so
      // in an oldest-first window they would occupy the whole batch every run, stalling deletion
      // site-wide for every other user.
      heldActive = (
        await dbRead.$queryRaw<{ id: number }[]>`
          SELECT id FROM "Image"
          WHERE "userId" = ANY(${heldUserIds})
            AND ingestion = 'Blocked'::"ImageIngestionStatus"
        `
      ).map((x) => x.id);

      // The held images that are past retention, i.e. the ones this run would otherwise delete.
      const wouldSkip = heldActive.length
        ? await dbRead.jobQueue.findMany({
            where: {
              type: JobQueueType.BlockedImageDelete,
              entityType: EntityType.Image,
              entityId: { in: heldActive },
              createdAt: { lte: cutoff },
            },
            select: { entityId: true },
          })
        : [];
      if (wouldSkip.length) {
        logToAxiom({
          name: 'remove-blocked-images',
          type: 'info',
          message: 'Would skip',
          reason: 'legal-hold',
          imageIds: wouldSkip.map((x) => x.entityId),
          count: wouldSkip.length,
        });
      }
    } catch (e) {
      logToAxiom({
        name: 'remove-blocked-images',
        type: 'error',
        message: 'Legal hold lookup failed; nothing deleted this run',
        error: e instanceof Error ? e.message : String(e),
      });
      return { skipped: 'legal-hold-lookup-failed' };
    }

    // The hold marker's statements below name its view, so on a database without it (a restore or a
    // copy from before its migration) they would fail part-way through: nothing is deleted there.
    if (!(await holdMarkerViewExists())) {
      logToAxiom({
        type: 'warning',
        name: 'remove-blocked-images',
        message: 'hold marker view missing: nothing deleted this run',
      }).catch(() => undefined);
      return { skipped: 'hold-marker-view-missing' };
    }

    // A hold that ends by its date writes nothing, so what it kept is swept here; a release purges
    // its own. A failure costs only the sweep. Gated like the deletes below, and kept above every
    // early return but the failed hold lookup and the missing view (which it names): it is also what
    // clears a copy made in a race with the release.
    if (env.DATABASE_IS_PROD)
      await dbWrite.$executeRaw`SELECT evidence_hold_purge_unheld()`.catch((error: unknown) =>
        logToAxiom({
          type: 'error',
          name: 'remove-blocked-images',
          message: 'evidence hold sweep failed',
          error: (error as Error)?.message,
        }).catch(() => undefined)
      );

    // A pending review decides this image's fate, so it is held until a moderator resolves it.
    // For an appeal, rejection clears needsReview and the next run deletes it; purging it first
    // strands the Appeal as Pending forever.
    // dbWrite for the same replica-lag reason as the CSAM lookup above.
    const reviewHeldRows = await dbWrite.$queryRaw<{ id: number; needsReview: string }[]>`
      SELECT id, "needsReview" FROM "Image"
      WHERE "needsReview" IN ('appeal', 'csam')
        AND ingestion = 'Blocked'::"ImageIngestionStatus"
    `;
    const appealHeld = reviewHeldRows.filter((x) => x.needsReview === 'appeal').map((x) => x.id);
    const csamReviewHeld = reviewHeldRows.filter((x) => x.needsReview === 'csam').map((x) => x.id);

    // An owner under a hold marker keeps every image whatever its review flag says. dbWrite for the
    // same replica-lag reason as above. Two statements, not a join: through the view's aggregate the
    // planner misjudges how many owners match and scans every Blocked image instead of each owner's.
    const evidenceHeldUserIds = (
      await dbWrite.$queryRaw<{ userId: number }[]>`SELECT "userId" FROM "EvidenceHeldUser"`
    ).map((x) => x.userId);
    const evidenceHeld = evidenceHeldUserIds.length
      ? (
          await dbWrite.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Image"
        WHERE "userId" = ANY(${evidenceHeldUserIds}::int[])
          AND ingestion = 'Blocked'::"ImageIngestionStatus"
      `
        ).map((x) => x.id)
      : [];

    // Every other hold on an account keeps all of its Blocked images, so they leave the batch for the
    // reason above.
    const accountHeld = (
      await dbWrite.$queryRaw<{ id: number }[]>(accountHeldBlockedImagesSql)
    ).map((x) => x.id);

    const held = [
      ...new Set([
        ...heldActive,
        ...appealHeld,
        ...csamReviewHeld,
        ...evidenceHeld,
        ...accountHeld,
      ]),
    ];
    const jobQueue = await dbRead.jobQueue.findMany({
      where: {
        type: JobQueueType.BlockedImageDelete,
        entityType: EntityType.Image,
        ...(held.length ? { entityId: { notIn: held } } : {}),
      },
      take: 15000,
      orderBy: { createdAt: 'asc' },
    });

    if (!jobQueue.length) {
      console.log('No blocked images in queue', {
        csamHeld: heldActive.length,
        appealHeld: appealHeld.length,
        csamReviewHeld: csamReviewHeld.length,
        evidenceHeld: evidenceHeld.length,
        accountHeld: accountHeld.length,
      });
      return finished({
        processed: 0,
        csamHeld: heldActive.length,
        appealHeld: appealHeld.length,
        csamReviewHeld: csamReviewHeld.length,
        evidenceHeld: evidenceHeld.length,
        accountHeld: accountHeld.length,
      });
    }

    const imageIds = jobQueue.map((j) => j.entityId);
    console.log(`Found ${imageIds.length} blocked images in queue`);

    // The queue row is written by trg_blocked_image_delete_queue on the transition into
    // Blocked, so its createdAt is the block time. Image.createdAt would start the clock at
    // upload, making anything blocked more than a week after upload deletable on the next run.
    const blockedAt = new Map(jobQueue.map((j) => [j.entityId, j.createdAt]));
    const images = await dbRead.$queryRaw<
      { id: number; userId: number; blockedFor: string | null }[]
    >`
    SELECT id, "userId", "blockedFor"
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

    console.log({
      imagesToDelete: imagesToDelete.length,
      waitingForRetention: waitingIds.length,
      csamHeld: heldActive.length,
      appealHeld: appealHeld.length,
      csamReviewHeld: csamReviewHeld.length,
      evidenceHeld: evidenceHeld.length,
      staleIds: staleIds.length,
    });

    if (!isProd) return { imagesToDelete: imagesToDelete.length };

    if (!env.DATABASE_IS_PROD) return { imagesToDelete: 0 };

    // Delete images that are past retention period.
    //
    // 🔴 RETRACTS — but NOT every image it deletes. `retractPublicBlobs` asks the image-cache
    // service to also delete the image's public copies and purge them from the CDN, so a redirect
    // cached before the delete stops resolving. Those copies are named from the image's own
    // storage key, so this reaches only this url (see `PurgeResizeCacheRetraction`). The
    // `cdn-access-sync` job asks for the same thing at takedown time, under the same rule.
    //
    // ── WHY THE DISCRIMINATOR IS POSITIVE ────────────────────────────────────────────────────
    // This job reads a QUEUE, so what reaches this line is decided by that queue's WRITERS, not
    // by this job's own callers. `trg_blocked_image_delete_queue` enqueues EVERY row that ends up
    // `ingestion = 'Blocked'` with a `blockedFor` other than 'AiNotVerified', whatever put it
    // there — including an INSERT that arrives already Blocked. That writer set is open: it grows
    // whenever anyone adds a block path, and it already contains automated scanners.
    //
    // So the split must not be "retract unless X", which opts every new and every automated
    // writer in by default and silently. It is "retract only where a human takedown decision on
    // THIS SPECIFIC IMAGE is affirmatively on record", and the record is `ModActivity`.
    //
    // `ModActivity` has three writers, all server-side and none reachable from a request body:
    // `trackModActivity` here, `recordModActivity` in the moderator app, and the auth hub's own
    // copy, which only ever writes `entityType: 'impersonate'`. Nothing a client submits reaches
    // it — which is the second reason it is used here rather than an `Image.metadata` marker:
    // `Image.metadata` is a `z.record(z.string(), z.any())` that `createImage` spreads verbatim
    // into the row, so a marker stored there is writable by the image's own uploader, in EITHER
    // polarity. Under a positive discriminator the forgeable direction would be worse than the
    // one this replaces: it would let an uploader trigger a retraction by forging the marker.
    //
    // The activity kinds counted are `MODERATOR_TAKEDOWN_ACTIVITIES`, and the row must be dated
    // at or after the queue row (i.e. at or after the block). Both halves matter — see the
    // constant for the enumeration behind each.
    //
    // ── WHAT EACH BLOCKED-IMAGE WRITER GETS, ENUMERATED OVER EVERY WRITE OF `ingestion` IN
    //    `src`, `apps` AND `packages` ─────────────────────────────────────────────────────────
    // RETRACTS — a moderator acted on one named image, and a per-image `review`/`bulkRemove` row
    //   is written in the same request:
    //     • `handleBlockImages` (image.service) WHEN CALLED WITH AN ID LIST — the `/api/mod/
    //       remove-images` bulk removal and the moderator app's own bulk remove, which also
    //       writes its own `bulkRemove` row per image.
    //     • `blockImage` in the moderator app (`apps/moderator/.../image-moderation.service.ts`).
    //     • `setTosViolationHandler` (image.controller) — the main app's single-image TOS
    //       takedown. Its `trackModActivity` call was added alongside this split; it is a
    //       moderator-gated per-image decision that previously left no row in the mod audit log
    //       at all.
    // DOES NOT RETRACT — the row is still hard-deleted here, exactly as before; only its public
    //   copies are not deleted:
    //     • the scan pipeline's three block outcomes — the orchestrator content rating
    //       (`blockImageFromRating`), the prompt/text audit, and the moderation rule engine
    //       (`image-scan-result.service` / `image-scan-pipeline`). Automated, no moderator, no
    //       `ModActivity`.
    //     • the CSAM branch of `report.service` — reached from `report.create`, which is a
    //       `guardedProcedureAllowUnverifiedEmail`, so it is fired by ANY reporting user's report
    //       and not by a moderator reviewing one. This is the writer that would be most dangerous
    //       to opt in by default: it is the only queue writer a stranger can aim at your image.
    //     • the Knights of New Order game (`new-order.service`), which calls `handleBlockImages`
    //       with an id but NO `moderatorId`, so no activity row is written. A community rating
    //       consensus is not a staff takedown decision.
    //     • `handleBlockImages` CALLED WITH A `userId` AND NO ID LIST, and `toggleBan`'s
    //       "remove all media" branch, and `softDeleteUser` — each blocks a whole library in one
    //       statement. The moderator decided about an ACCOUNT, not about each image's bytes, and
    //       the ids never reach a per-image record; `removeAllImagesForUser` says so in its own
    //       docstring. Consistent with `api/mod/delete-user-images`, which never retracted.
    //     • `remove-deleted-user-images` — a user deleting their OWN account with the 7-day grace
    //       option. Nothing was moderated; it must not reach another owner's bytes.
    //     • anything else that lands in the queue, now or later, including a writer added after
    //       this comment was written. That is the property being bought.
    //
    // ── WHAT RETRACTION KEYS ON ──────────────────────────────────────────────────────────────
    // A `MODERATOR_TAKEDOWN_ACTIVITIES` row on the image dated at or after its queue row's
    // `createdAt`; without one the image is still deleted, but not retracted. Every un-block that
    // writes a `review` row drops the image's queue row, so that row is never compared against a
    // later block. A new one has to do the same.
    //
    // No other caller of `deleteImages` passes the option at all: an ordinary user deleting their
    // own picture, a replaced image being reaped, an account being drained in `immediate` mode and
    // the moderator bulk endpoint all keep today's variant-only invalidation.
    const takedownCandidateIds = imagesToDelete.map((x) => x.id);
    // MAX rather than an EXISTS correlated per row: one grouped read for the whole batch, and the
    // comparison against each image's own block time then happens in memory.
    const moderatorActivity = takedownCandidateIds.length
      ? await dbRead.$queryRaw<{ entityId: number; lastActedAt: Date }[]>`
      SELECT "entityId", MAX("createdAt") AS "lastActedAt"
      FROM "ModActivity"
      WHERE "entityId" = ANY(${takedownCandidateIds})
        AND "entityType" = 'image'
        AND activity = ANY(${[...MODERATOR_TAKEDOWN_ACTIVITIES]}::text[])
      GROUP BY "entityId"
    `
      : [];
    const lastActedAt = new Map(moderatorActivity.map((r) => [r.entityId, r.lastActedAt]));

    // A moderator acted on this image at or after it was blocked. `queuedAt` is non-null for
    // everything in `imagesToDelete` — that is what put it there — but it is re-read rather than
    // asserted, so a future change to that filter degrades to NOT retracting.
    const isTakedown = (id: number) => {
      const queuedAt = blockedAt.get(id);
      const actedAt = lastActedAt.get(id);
      return !!queuedAt && !!actedAt && actedAt.getTime() >= queuedAt.getTime();
    };
    const takedowns = takedownCandidateIds.filter(isTakedown);
    const deletedWithoutRetraction = takedownCandidateIds.filter((id) => !isTakedown(id));
    const onlyWhere = purgeHoldGuard({ holdForTrainingCopy: isAppealTrainingConfigured() });
    const deleted: number[] = [];
    if (takedowns.length > 0) {
      // The CDN sync purged these urls' CDN entries at takedown time, and the retention window
      // outlasts anything cached before the deny, so this sends no CDN purge of its own.
      const rows = await deleteImages(takedowns, true, {
        retractPublicBlobs: true,
        persistTakedown: true,
        onlyWhere,
      });
      deleted.push(...rows.map((x) => x.id));
    }
    if (deletedWithoutRetraction.length > 0) {
      const rows = await deleteImages(deletedWithoutRetraction, true, { onlyWhere });
      deleted.push(...rows.map((x) => x.id));
    }
    const deletedSet = new Set(deleted);
    const heldAtDelete = takedownCandidateIds.filter((id) => !deletedSet.has(id));

    // Remove processed and stale entries from queue. Anything the guard kept stays queued.
    const idsToRemove = [...deleted, ...staleIds];
    if (idsToRemove.length > 0) {
      await dbWrite.$executeRaw`
      DELETE FROM "JobQueue"
      WHERE type = ${JobQueueType.BlockedImageDelete}::"JobQueueType"
        AND "entityType" = ${EntityType.Image}::"EntityType"
        AND "entityId" = ANY(${idsToRemove})
    `;
    }

    return finished({
      deleted: deleted.length,
      heldAtDelete: heldAtDelete.length,
      // Reported separately so the two populations are legible in the job's own output: the
      // second number is deletions that deliberately left the public copies to expire. It is
      // NOT "account deletions" — it is everything with no moderator takedown on record, which is
      // account deletions plus every automated block plus every whole-library block.
      retracted: takedowns.filter((id) => deletedSet.has(id)).length,
      deletedWithoutRetraction: deletedWithoutRetraction.filter((id) => deletedSet.has(id)).length,
      staleRemoved: staleIds.length,
      waitingForRetention: waitingIds.length,
      csamHeld: heldActive.length,
      appealHeld: appealHeld.length,
      csamReviewHeld: csamReviewHeld.length,
      evidenceHeld: evidenceHeld.length,
      accountHeld: accountHeld.length,
    });
  },
  // Deleting 15k images per run can exceed the 5-min default lock; a second pod
  // grabbing the lock mid-run would double-delete and hit S3/DB twice.
  { lockExpiration: 20 * 60 }
);
