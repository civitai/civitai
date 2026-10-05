import type {
  ImageScanningJointAgeDetection,
  ImageScanningOutput,
  NsfwLevel,
} from '@civitai/orchestration-client';
import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';
import { logToAxiom } from '~/server/logging/client';
import {
  applyIngestionSideEffects,
  buildAndInsertScanTags,
  extractFailedSteps,
  loadImageForScan,
  logPerceptualHashMatch,
  markImageScanError,
  readJobFailureReason,
  resolveScanOutcome,
  sendIngestionSignal,
  type ScanLog,
} from '~/server/services/image-scan-pipeline';
import { removeImageScanJobQueue } from '~/server/services/job-queue.service';
import { computePerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import { recordImageScanningResult } from '~/server/services/scanner-audit.service';
import { fanOutArticleImageUpdates } from '~/server/utils/webhook-debounce';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

type RawRepeatStep = {
  $type?: string;
  input?: { template?: { $type?: string } };
  output?: { steps?: Array<{ $type?: string }> };
};

/** Whether a workflow was submitted with imageScanning, whatever state its steps ended in. */
export function isImageScanningWorkflow(steps: unknown[]) {
  return (steps as RawRepeatStep[]).some(
    (step) =>
      step.$type === 'imageScanning' ||
      (step.$type === 'repeat' &&
        (step.input?.template?.$type === 'imageScanning' ||
          step.output?.steps?.[0]?.$type === 'imageScanning'))
  );
}

type Recognition = { label: string; score: number };

/** One image's scan, or a video's frames combined into one. */
export type ImageScanningResult = {
  nsfwLevel: NsfwLevel;
  tags: Record<string, number>;
  csam: boolean | null;
  ageDetections: ImageScanningJointAgeDetection[];
  minorDetected: boolean;
  aiRecognition?: Recognition;
  animeRecognition?: Recognition;
  perceptualHash?: string;
};

type RawStep = { $type?: string; name?: string; status?: string; output?: unknown };

// wdTagging only ever returned general tags; the other categories would write tags no image had before.
const INGESTED_TAG_CATEGORIES = new Set(['general']);

function readScan(output: ImageScanningOutput, workflowId: string): ImageScanningResult {
  const { tagging, jointAgeClassification } = output;
  // An unmapped level ('na', or one added upstream) would write a rating with no NSFW level.
  // Not "invalid media…": classifyImageScanFailure reads that as permanent, and this is recoverable.
  if (orchestratorNsfwLevelMap[output.nsfwLevel] === undefined)
    throw new Error(`media rating unavailable (${output.nsfwLevel}) for workflow: ${workflowId}`);
  if (!tagging?.ran)
    throw new Error(`Incomplete workflow: ${workflowId}. Tagging did not run (${tagging?.status})`);

  const tags: Record<string, number> = {};
  for (const { tag, category, score } of tagging.tags) {
    if (INGESTED_TAG_CATEGORIES.has(category)) tags[tag] = Math.max(score, tags[tag] ?? 0);
  }

  return {
    nsfwLevel: output.nsfwLevel,
    tags,
    csam: output.csam ?? null,
    ageDetections: jointAgeClassification?.detections ?? [],
    minorDetected: !!jointAgeClassification?.minorDetected,
    aiRecognition: output.aiRecognition,
    animeRecognition: output.animeRecognition,
  };
}

const higher = (a?: Recognition, b?: Recognition) => (!a || (b && b.score > a.score) ? b : a);

// Every result is kept (a max or an OR per field), so a frame can only raise what the video reports.
function combineFrames(frames: ImageScanningResult[]): ImageScanningResult {
  return frames.reduce((acc, frame) => {
    const tags = { ...acc.tags };
    for (const [tag, score] of Object.entries(frame.tags))
      tags[tag] = Math.max(score, tags[tag] ?? 0);
    return {
      nsfwLevel:
        orchestratorNsfwLevelMap[frame.nsfwLevel] > orchestratorNsfwLevelMap[acc.nsfwLevel]
          ? frame.nsfwLevel
          : acc.nsfwLevel,
      tags,
      csam: acc.csam || frame.csam ? true : acc.csam ?? frame.csam,
      ageDetections: [...acc.ageDetections, ...frame.ageDetections],
      minorDetected: acc.minorDetected || frame.minorDetected,
      aiRecognition: higher(acc.aiRecognition, frame.aiRecognition),
      animeRecognition: higher(acc.animeRecognition, frame.animeRecognition),
    };
  });
}

/**
 * Reads a succeeded imageScanning ingestion workflow: one `imageScanning` step for an image,
 * or a `repeat` of them over extracted frames for a video, plus the `mediaHash` step.
 * Throws when the workflow carries nothing usable.
 */
export function parseImageScanningSteps(workflowSteps: unknown[], workflowId: string) {
  const steps = workflowSteps as RawStep[];
  const perceptualHash = (
    steps.find((step) => step.$type === 'mediaHash')?.output as
      | { hashes?: { perceptual?: string } }
      | undefined
  )?.hashes?.perceptual;

  const single = steps.find((step) => step.$type === 'imageScanning')?.output;
  if (single) return { ...readScan(single as ImageScanningOutput, workflowId), perceptualHash };

  const frames = (
    steps.find(
      (step) =>
        step.$type === 'repeat' &&
        (step.output as { steps?: RawStep[] } | undefined)?.steps?.[0]?.$type === 'imageScanning'
    )?.output as { steps: RawStep[] } | undefined
  )?.steps;
  if (!frames?.length || !frames.every((frame) => frame.output))
    throw new Error(`Incomplete workflow: ${workflowId}. Missing imageScanning output`);

  return {
    ...combineFrames(
      frames.map((frame) => readScan(frame.output as ImageScanningOutput, workflowId))
    ),
    perceptualHash,
  };
}

export const IMAGE_SCANNING_LOG: ScanLog = {
  name: 'image-scanning-result',
  source: 'image-scanning-result.service',
};

type ScanErrorInput = Parameters<typeof markImageScanError>[0];

async function failScan(
  input: ScanErrorInput & {
    articleImageScanning: boolean;
    logType: 'warning' | 'error';
    message: string;
    stack?: string;
  }
) {
  const { articleImageScanning, logType, message, stack, ...error } = input;
  const { retryCount, mediaType, userId, failureClass } = await markImageScanError(error);
  logToAxiom(
    {
      name: IMAGE_SCANNING_LOG.name,
      type: logType,
      message,
      source: IMAGE_SCANNING_LOG.source,
      stack,
      ...error,
      failureClass,
      mediaType,
      retryCount,
    },
    'webhooks'
  ).catch(() => null);
  await sendIngestionSignal({
    imageId: error.imageId,
    userId,
    ingestion: ImageIngestionStatus.Error,
    log: IMAGE_SCANNING_LOG,
  });
  if (articleImageScanning) await fanOutArticleImageUpdates(error.imageId);
}

/** Core image scan processing for imageScanning workflows. */
export async function processImageScanningWorkflow({
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
  steps: unknown[];
  imageId: number;
  articleImageScanning?: boolean;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
}) {
  if (status !== 'succeeded') {
    await failScan({
      workflowId,
      imageId,
      status,
      failureType:
        status === 'expired' ? 'expired' : status === 'canceled' ? 'canceled' : 'workflow-failed',
      failedSteps: extractFailedSteps(steps),
      reason: await readJobFailureReason(workflowId),
      articleImageScanning,
      logType: 'warning',
      message: `workflow not succeeded: ${status}`,
    });
    return;
  }

  let scan: ReturnType<typeof parseImageScanningSteps>;
  try {
    scan = parseImageScanningSteps(steps, workflowId);
  } catch (error) {
    await failScan({
      workflowId,
      imageId,
      status,
      failureType: 'unusable-result',
      failedSteps: extractFailedSteps(steps),
      reason: error instanceof Error ? error.message : 'Unknown error',
      articleImageScanning,
      logType: 'warning',
      message: 'succeeded workflow had no usable result',
    });
    return;
  }

  let image: Awaited<ReturnType<typeof loadImageForScan>>;
  let outcome: Awaited<ReturnType<typeof resolveScanOutcome>>;
  try {
    const pHash = computePerceptualHash(scan.perceptualHash);
    if (pHash) await logPerceptualHashMatch({ imageId, pHash, log: IMAGE_SCANNING_LOG });

    image = await loadImageForScan(imageId);
    const { prompt, negativePrompt } = (image.meta ?? {}) as {
      prompt?: string;
      negativePrompt?: string;
    };
    await buildAndInsertScanTags({
      imageId,
      wdTags: scan.tags,
      ratingLevel: scan.nsfwLevel,
      prompt,
    });
    outcome = await resolveScanOutcome({
      image,
      pHash,
      workflowId,
      prompt,
      negativePrompt,
      log: IMAGE_SCANNING_LOG,
    });
  } catch (error) {
    // Deleted between submit and callback — no row to mark. The route ACKs it.
    if (error instanceof Error && error.message.startsWith('image not found')) throw error;
    await failScan({
      workflowId,
      imageId,
      status,
      failureType: 'processing-failed',
      failedSteps: extractFailedSteps(steps),
      reason: error instanceof Error ? error.message : 'Unknown error',
      articleImageScanning,
      logType: 'error',
      message: 'failed to process a succeeded workflow',
      stack: error instanceof Error ? error.stack : undefined,
    });
    return;
  }

  // The verdict is persisted; throwing now would 400 a finished webhook and make the
  // orchestrator re-run it.
  try {
    await removeImageScanJobQueue([imageId]);
    await recordImageScanningResult({ workflowId, imageId, scan, startedAt, completedAt });
    if (articleImageScanning) await fanOutArticleImageUpdates(imageId);
    await applyIngestionSideEffects({ image, outcome });
  } catch (error) {
    logToAxiom(
      {
        name: IMAGE_SCANNING_LOG.name,
        type: 'error',
        message: 'side effects failed after the scan verdict was persisted',
        source: IMAGE_SCANNING_LOG.source,
        stack: error instanceof Error ? error.stack : undefined,
        reason: error instanceof Error ? error.message : 'Unknown error',
        imageId,
        workflowId,
        ingestion: outcome.ingestion,
      },
      'webhooks'
    ).catch(() => null);
  }

  await sendIngestionSignal({
    imageId,
    userId: image.userId,
    ingestion: outcome.ingestion,
    blockedFor: outcome.blockedFor,
    log: IMAGE_SCANNING_LOG,
  });
}
