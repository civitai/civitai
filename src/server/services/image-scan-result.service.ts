import type { MediaRatingOutput } from '@civitai/client';
import { dbWrite } from '~/server/db/client';
import { computePerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';
import { isDefined } from '~/utils/type-guards';
import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';
import type { MediaMetadata } from '~/server/schema/media.schema';
import { fanOutArticleImageUpdates } from '~/server/utils/webhook-debounce';
import { logToAxiom } from '~/server/logging/client';
import { recordImageScan } from '~/server/services/scanner-audit.service';
import { removeImageScanJobQueue } from '~/server/services/job-queue.service';
import {
  readJobFailureReason,
  sendIngestionSignal,
  logPerceptualHashMatch,
  extractFailedSteps,
  markImageScanError,
  loadImageForScan,
  buildAndInsertScanTags,
  resolveScanOutcome,
  applyIngestionSideEffects,
  type ScanImage,
} from '~/server/services/image-scan-pipeline';

export async function isExemptFromAiVerification(
  imageId: number,
  metadata?: MediaMetadata | null
): Promise<boolean> {
  // Fast path: check metadata flags (no DB query needed)
  if (metadata?.profilePicture) return true;
  if (metadata?.coverImage) return true;

  // DB fallback: check relationships for existing images without metadata flags
  const [result] = await dbWrite.$queryRaw<{ exempt: boolean }[]>`
    SELECT (
      EXISTS(SELECT 1 FROM "User" WHERE "profilePictureId" = ${imageId}) OR
      EXISTS(SELECT 1 FROM "UserProfile" WHERE "coverImageId" = ${imageId}) OR
      EXISTS(SELECT 1 FROM "Article" WHERE "coverId" = ${imageId}) OR
      EXISTS(SELECT 1 FROM "Challenge" WHERE "coverImageId" = ${imageId}) OR
      EXISTS(SELECT 1 FROM "ImageConnection" WHERE "imageId" = ${imageId} AND "entityType" IN ('Bounty', 'Article'))
    ) AS exempt
  `;
  return result?.exempt ?? false;
}

type WdTaggingStep = {
  $type: 'wdTagging';
  output: { tags: Record<string, number>; rating: Record<string, number> };
};
type MediaRatingStep = {
  $type: 'mediaRating';
  output: MediaRatingOutput;
};
type MediaHashStep = {
  $type: 'mediaHash';
  output: { hashes: { perceptual: string } };
};
type RepeatStep = {
  $type: 'repeat';
  output: {
    steps: Array<MediaRatingStep | WdTaggingStep>;
  };
};
export type ScanResultStep = WdTaggingStep | MediaRatingStep | MediaHashStep | RepeatStep;

/**
 * Scan result processing for wdTagging + mediaRating workflows. Its stages are shared with
 * the imageScanning handler in `image-scan-pipeline`.
 */
export async function processImageScanWorkflow({
  workflowId,
  status,
  steps,
  imageId,
  articleImageScanning = false,
  startedAt,
  completedAt,
}: {
  workflowId: string;
  status: string;
  steps: ScanResultStep[];
  imageId: number;
  /** Enable debounced article ingestion updates (webhook path with feature flag) */
  articleImageScanning?: boolean;
  /** Workflow timing for the scanner_label_results audit log. */
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
}) {
  if (status !== 'succeeded') {
    // Which orchestrator steps failed (wdTagging / mediaHash / mediaRating) plus
    // the job-level `reason` — captured off the `job:failed`/`job:expired`
    // callback (getWorkflow itself exposes no per-job error) — are how we tell
    // transient infra churn (Siglip container instability, 5xx, timeouts,
    // expiry) apart from a genuinely unscannable image. `markImageScanError`
    // stamps a `failureClass` from those signals; the `ingest-images` cron uses
    // it to pick a retry ceiling. retryCount ALWAYS bumps (the absolute backstop).
    const failedSteps = extractFailedSteps(steps);
    const failureType =
      status === 'expired' ? 'expired' : status === 'canceled' ? 'canceled' : 'workflow-failed';
    const reason = await readJobFailureReason(workflowId);
    const { retryCount, mediaType, userId, failureClass } = await markImageScanError({
      workflowId,
      imageId,
      status,
      failureType,
      failedSteps,
      reason,
    });
    logToAxiom(
      {
        name: 'image-scan-result',
        type: 'warning',
        message: `workflow not succeeded: ${status}`,
        source: 'image-scan-result.service',
        failureType,
        failedSteps,
        reason,
        failureClass,
        imageId,
        mediaType,
        workflowId,
        status,
        retryCount,
      },
      'webhooks'
    ).catch(() => null);
    await sendIngestionSignal({ imageId, userId, ingestion: ImageIngestionStatus.Error });
    if (articleImageScanning) await fanOutArticleImageUpdates(imageId);
    return;
  }

  // A workflow can succeed and still carry nothing usable — most often a video whose frame
  // extraction returned zero frames. Record it like any other scan failure so the retry
  // ceiling can terminalize it, and ACK: the workflow is terminal, so redelivering it would
  // only reproduce the same parse failure.
  let parsed: ReturnType<typeof parseScanSteps>;
  try {
    parsed = parseScanSteps({ steps, workflowId });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown error';
    const { retryCount, mediaType, userId, failureClass } = await markImageScanError({
      workflowId,
      imageId,
      status,
      failureType: 'unusable-result',
      failedSteps: extractFailedSteps(steps),
      reason,
    });
    logToAxiom(
      {
        name: 'image-scan-result',
        type: 'warning',
        message: 'succeeded workflow had no usable result',
        source: 'image-scan-result.service',
        failureType: 'unusable-result',
        reason,
        failureClass,
        imageId,
        mediaType,
        workflowId,
        retryCount,
      },
      'webhooks'
    ).catch(() => null);
    await sendIngestionSignal({ imageId, userId, ingestion: ImageIngestionStatus.Error });
    if (articleImageScanning) await fanOutArticleImageUpdates(imageId);
    return;
  }

  const { wdTags, mediaRating, mediaHash } = parsed;

  // Scope stops at the outcome write: markImageScanError is unconditional, so
  // widening this catch past it would overwrite a verdict that already landed.
  let image: ScanImage;
  let outcome: Awaited<ReturnType<typeof resolveScanOutcome>>;
  // blockImageFromRating lands a verdict partway through the block below, so the
  // catch has to know whether one is already on the row.
  let hardBlocked = false;
  try {
    const pHash = computePerceptualHash(mediaHash?.hashes?.perceptual);

    // Log (don't act on) perceptual-hash matches against known-blocked content.
    if (!mediaRating.isBlocked && pHash) await logPerceptualHashMatch({ imageId, pHash });

    // The orchestrator content rating can hard-block the image outright.
    if (mediaRating.isBlocked) {
      await blockImageFromRating({ imageId, pHash, blockedReason: mediaRating.blockedReason });
      hardBlocked = true;
    }

    image = await loadImageForScan(imageId);
    const { prompt, negativePrompt } = (image.meta ?? {}) as {
      prompt?: string;
      negativePrompt?: string;
    };

    await buildAndInsertScanTags({
      imageId: image.id,
      wdTags,
      ratingLevel: mediaRating.nsfwLevel,
      prompt,
    });

    outcome = await resolveScanOutcome({
      image,
      blocked: mediaRating.isBlocked ? { reason: mediaRating.blockedReason ?? null } : undefined,
      pHash,
      workflowId,
      prompt,
      negativePrompt,
    });
  } catch (error) {
    // Deleted between submit and callback — no row to mark. The handler ACKs it 200.
    if (error instanceof Error && error.message.startsWith('image not found')) throw error;

    const reason = error instanceof Error ? error.message : 'Unknown error';
    // Marking Error here would un-block a hard-blocked image and hand it back to the
    // retry pipeline. The verdict stands; only the tagging and side-effect work is lost.
    if (hardBlocked) {
      logToAxiom(
        {
          name: 'image-scan-result',
          type: 'error',
          message: 'failed to process a workflow after its rating hard-blocked the image',
          source: 'image-scan-result.service',
          stack: error instanceof Error ? error.stack : undefined,
          reason,
          imageId,
          workflowId,
          status,
        },
        'webhooks'
      ).catch(() => null);
      if (articleImageScanning) await fanOutArticleImageUpdates(imageId);
      return;
    }

    const { retryCount, mediaType, userId, failureClass } = await markImageScanError({
      workflowId,
      imageId,
      status,
      failureType: 'processing-failed',
      failedSteps: extractFailedSteps(steps),
      reason,
    });
    logToAxiom(
      {
        name: 'image-scan-result',
        type: 'error',
        message: 'failed to process a succeeded workflow',
        source: 'image-scan-result.service',
        stack: error instanceof Error ? error.stack : undefined,
        failureType: 'processing-failed',
        reason,
        failureClass,
        imageId,
        mediaType,
        workflowId,
        status,
        retryCount,
      },
      'webhooks'
    ).catch(() => null);
    await sendIngestionSignal({ imageId, userId, ingestion: ImageIngestionStatus.Error });
    if (articleImageScanning) await fanOutArticleImageUpdates(imageId);
    return;
  }

  // The verdict is persisted; throwing here would 400 a finished webhook and have
  // the orchestrator re-run it. Log and fall through to the signal send.
  try {
    // Terminal outcome reached (resolveScanOutcome only ever returns Scanned or
    // Blocked) — drop the ImageScan JobQueue row so it doesn't linger as a stale
    // entry until the ingest-images cron happens to prune it. Error scans take the
    // early-return branches above and stay queued for retry.
    await removeImageScanJobQueue([image.id]);

    await recordImageScan({
      workflowId,
      imageId: image.id,
      mediaRating,
      startedAt,
      completedAt,
    });

    // Fan out to articles for every terminal state (Scanned and Blocked).
    // Article ingestion must advance on Blocked too, otherwise articles whose last
    // image blocks stay stuck in Pending/Rescan.
    if (articleImageScanning) await fanOutArticleImageUpdates(image.id);

    await applyIngestionSideEffects({ image, outcome });
  } catch (error) {
    logToAxiom(
      {
        name: 'image-scan-result',
        type: 'error',
        message: 'side effects failed after the scan verdict was persisted',
        source: 'image-scan-result.service',
        stack: error instanceof Error ? error.stack : undefined,
        reason: error instanceof Error ? error.message : 'Unknown error',
        imageId: image.id,
        workflowId,
        ingestion: outcome.ingestion,
      },
      'webhooks'
    ).catch(() => null);
  }

  // Last step, after everything is committed — throwing here would 400 a finished webhook
  // and make the orchestrator re-run it.
  await sendIngestionSignal({
    imageId: image.id,
    userId: image.userId,
    ingestion: outcome.ingestion,
    blockedFor: outcome.blockedFor,
  });
}

// Step parsing
// --------------------------------------------------
function parseScanSteps({ steps, workflowId }: { steps: ScanResultStep[]; workflowId: string }) {
  const wdTagging =
    steps.find((x) => x.$type === 'wdTagging')?.output ?? aggregateWdTaggingRepeater(steps);
  const mediaRating =
    steps.find((x) => x.$type === 'mediaRating')?.output ?? aggregateMediaRatingRepeater(steps);
  const mediaHash = steps.find((x) => x.$type === 'mediaHash')?.output;

  const missingSteps: string[] = [];
  if (!wdTagging) missingSteps.push('wdTagging');
  if (!mediaRating) missingSteps.push('mediaRating');

  if (missingSteps.length > 0)
    throw new Error(
      `Incomplete workflow: ${workflowId}. Missing steps: ${missingSteps.join(', ')}`
    );

  // Not "invalid media…" — that substring reads as a permanently-bad file to
  // classifyImageScanFailure, and an 'na' rating arrives in bursts, so it is recoverable.
  if (mediaRating?.nsfwLevel === 'na')
    throw new Error(`media rating unavailable for workflow: ${workflowId}`);

  return { wdTags: wdTagging!.tags, mediaRating: mediaRating!, mediaHash };
}

// All-or-nothing, not a filter: nsfwLevel aggregates as a max and isBlocked as an OR, so
// dropping a frame can only ever under-rate the video.
function hasEveryFrameOutput(frames: Array<{ output?: unknown }>) {
  return frames.length > 0 && frames.every((x) => isDefined(x?.output));
}

function aggregateWdTaggingRepeater(steps: ScanResultStep[]) {
  const step = steps.find(
    (x) => x.$type === 'repeat' && x.output?.steps?.[0]?.$type === 'wdTagging'
  ) as RepeatStep | undefined;
  if (!step) return;

  const wdTaggingSteps = step.output.steps as WdTaggingStep[];
  if (!hasEveryFrameOutput(wdTaggingSteps)) return;

  return wdTaggingSteps.reduce<WdTaggingStep['output']>(
    (acc, step) => {
      for (const [tag, confidence] of Object.entries(step.output.tags ?? {})) {
        const current = acc.tags[tag];
        if (!current) acc.tags[tag] = confidence;
        else if (confidence > current) acc.tags[tag] = confidence;
      }
      for (const [rating, confidence] of Object.entries(step.output.rating ?? {})) {
        const current = acc.rating[rating];
        if (!current) acc.rating[rating] = confidence;
        else if (confidence > current) acc.rating[rating] = confidence;
      }
      return acc;
    },
    { tags: {}, rating: {} }
  );
}

function aggregateMediaRatingRepeater(steps: ScanResultStep[]) {
  const step = steps.find(
    (x) => x.$type === 'repeat' && x.output?.steps?.[0]?.$type === 'mediaRating'
  ) as RepeatStep | undefined;
  if (!step) return;

  const mediaRatingSteps = step.output.steps as MediaRatingStep[];
  if (!hasEveryFrameOutput(mediaRatingSteps)) return;

  return mediaRatingSteps.reduce<MediaRatingStep['output']>(
    (acc, step) => {
      const {
        nsfwLevel,
        isBlocked,
        blockedReason,
        ageClassification,
        faceRecognition,
        aiRecognition,
        animeRecognition,
      } = step.output;
      if (!acc.isBlocked) acc.isBlocked = isBlocked;
      if (!acc.blockedReason) acc.blockedReason = blockedReason;

      if (orchestratorNsfwLevelMap[nsfwLevel] > orchestratorNsfwLevelMap[acc.nsfwLevel])
        acc.nsfwLevel = nsfwLevel;

      if (ageClassification?.detections.length) {
        acc.ageClassification ??= { detections: [] };
        acc.ageClassification.detections.push(...ageClassification.detections);
      }
      if (faceRecognition?.faces.length) {
        acc.faceRecognition ??= { faces: [] };
        acc.faceRecognition.faces.push(...faceRecognition.faces);
      }
      if (
        aiRecognition &&
        (!acc.aiRecognition || aiRecognition.confidence > acc.aiRecognition.confidence)
      ) {
        acc.aiRecognition = aiRecognition;
      }
      if (
        animeRecognition &&
        (!acc.animeRecognition || animeRecognition.confidence > acc.animeRecognition.confidence)
      ) {
        acc.animeRecognition = animeRecognition;
      }

      return acc;
    },
    { nsfwLevel: 'pg', isBlocked: false }
  );
}

async function blockImageFromRating({
  imageId,
  pHash,
  blockedReason,
}: {
  imageId: number;
  pHash?: bigint;
  blockedReason?: string | null;
}) {
  await dbWrite.image.updateMany({
    where: { id: imageId },
    data: {
      pHash,
      ingestion: ImageIngestionStatus.Blocked,
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: blockedReason,
    },
  });
}
