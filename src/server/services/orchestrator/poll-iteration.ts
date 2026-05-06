import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getImageUploadBackend } from '~/utils/s3-utils';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { createImage } from '~/server/services/image.service';
import { registerMediaLocation } from '~/server/services/storage-resolver';
import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';

/**
 * Translate the orchestrator's string nsfwLevel ("pg", "pg13", "r", ...)
 * into the numeric `NsfwLevel` bitfield the rest of the app uses.
 *
 * Critical: without this mapping, `hasSafeBrowsingLevel("pg13")` does
 * bitwise math on a string, which coerces to NaN, and PG-13 outputs get
 * mis-classified as mature on the client (showing the "rated mature,
 * open on civitai.red" overlay for safe images).
 */
function normalizeOrchestratorNsfwLevel(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return orchestratorNsfwLevelMap[normalized];
  }
  return undefined;
}

interface PollIterationArgs {
  workflowId: string;
  width?: number;
  height?: number;
  prompt?: string;
  userId: number;
  ctx: any;
}

async function downloadAndUploadImage(
  imageUrl: string,
  userId: number,
  width: number,
  height: number,
  prompt?: string
): Promise<{ s3Key: string; imageId: number } | null> {
  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok)
      throw new Error(`Failed to download: ${imageResponse.status}`);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    const s3Key = randomUUID();
    const { s3, bucket, backend } = await getImageUploadBackend();
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: imageBuffer,
        ContentType: imageResponse.headers.get('content-type') || 'image/jpeg',
      })
    );
    registerMediaLocation(s3Key, backend, imageBuffer.length);

    const image = await createImage({
      url: s3Key,
      type: 'image',
      userId,
      width,
      height,
      meta: prompt ? ({ prompt } as any) : undefined,
    });

    return { s3Key, imageId: image.id };
  } catch (e) {
    console.error('Failed to upload iteration image to S3:', e);
    return null;
  }
}

export async function pollIterationWorkflow({
  workflowId,
  width,
  height,
  prompt,
  userId,
  ctx,
}: PollIterationArgs) {
  const token = await getOrchestratorToken(userId, ctx);
  const workflow = await getWorkflow({
    token,
    path: { workflowId },
  });

  const steps = workflow.steps ?? [];
  const firstStep = steps[0] as any;
  const rawImages: any[] = firstStep?.output?.images ?? firstStep?.output?.blobs ?? [];
  const outputImages: string[] = rawImages.map((img) => img?.url).filter(Boolean) as string[];

  // Mirror the queue item's `errored` logic: any terminal status (succeeded /
  // failed / expired / canceled) where the worker finished without producing a
  // usable blob is a hard failure, not a "still working". Without these
  // checks the editor sits on the spinner forever.
  const TERMINAL_STATUSES = ['succeeded', 'failed', 'expired', 'canceled'] as const;
  const stepStatus = firstStep?.status as string | undefined;
  const workflowStatus = workflow.status as string | undefined;
  const stepReachedTerminal = !!stepStatus && TERMINAL_STATUSES.includes(stepStatus as any);
  const workflowReachedTerminal =
    !!workflowStatus && TERMINAL_STATUSES.includes(workflowStatus as any);

  // On the SFW domain, mature outputs come back with `available: false` and a
  // `siteRestricted` blocked reason — the URL is suppressed. Hand off to a
  // mature-content domain so the user can use the workflow they already paid
  // for.
  if (
    (workflowStatus === 'succeeded' || stepStatus === 'succeeded') &&
    outputImages.length === 0 &&
    rawImages.some((img) => img?.blockedReason === 'siteRestricted')
  ) {
    return {
      status: 'siteRestricted' as const,
      workflowId: workflow.id as string,
      imageUrl: null,
      images: [],
    };
  }

  // Look for a non-siteRestricted blocked reason on the output. We surface a
  // tailored failure message so the user knows whether the Buzz was refunded
  // or is simply held pending an unlock action they can take in the queue.
  const blockedReason = rawImages.find((img) => img?.blockedReason)?.blockedReason as
    | string
    | undefined;

  if (workflowStatus === 'succeeded' && outputImages.length > 0) {
    const imgWidth = width ?? 512;
    const imgHeight = height ?? 512;

    // Pair each raw orchestrator image with its nsfwLevel so the client can
    // blur mature outputs immediately, before our async ingestion has had a
    // chance to recompute it on the Image record.
    const rawByUrl = new Map(rawImages.filter((img) => img?.url).map((img) => [img.url, img]));

    const results = await Promise.all(
      outputImages.map(async (url) => {
        const uploaded = await downloadAndUploadImage(url, userId, imgWidth, imgHeight, prompt);
        if (!uploaded) return null;
        return {
          ...uploaded,
          nsfwLevel: normalizeOrchestratorNsfwLevel(rawByUrl.get(url)?.nsfwLevel),
        };
      })
    );

    const uploaded = results.filter(Boolean) as {
      s3Key: string;
      imageId: number;
      nsfwLevel?: number;
    }[];
    if (uploaded.length === 0) {
      return { status: 'failed' as const, imageUrl: null, images: [] };
    }

    return {
      status: 'succeeded' as const,
      imageUrl: uploaded[0].s3Key,
      imageId: uploaded[0].imageId,
      images: uploaded.map((u) => ({ url: u.s3Key, id: u.imageId, nsfwLevel: u.nsfwLevel })),
    };
  }

  // Hard failure: workflow itself terminated without success.
  if (
    workflowStatus === 'failed' ||
    workflowStatus === 'canceled' ||
    workflowStatus === 'expired'
  ) {
    return {
      status: 'failed' as const,
      imageUrl: null,
      images: [],
      errorMessage: blockedReasonToMessage(blockedReason),
    };
  }

  // Soft failure: the step reached a terminal state but no blob ever became
  // available. The queue item shows the same "errored" / blocked card in this
  // situation; without this branch the iterative editor would hang on the
  // spinner. Surface a tailored message based on any blockedReason present.
  if ((stepReachedTerminal || workflowReachedTerminal) && outputImages.length === 0) {
    return {
      status: 'failed' as const,
      imageUrl: null,
      images: [],
      errorMessage: blockedReasonToMessage(blockedReason),
    };
  }

  // Still processing
  return { status: 'processing' as const, imageUrl: null, images: [] };
}

/**
 * Map an output's blockedReason to something useful for the iterative editor.
 * Mirrors the queue's blocked-reason cards but as plain text — the editor
 * doesn't yet have a full unlock-in-place UI, so we point users at the queue
 * for the actions that need to happen there.
 */
function blockedReasonToMessage(blockedReason: string | undefined): string | undefined {
  if (!blockedReason) return undefined;
  switch (blockedReason) {
    case 'canUpgrade':
      return 'Mature content was generated. Open the Generator queue to unlock it with yellow Buzz — your Buzz is held, not lost.';
    case 'membershipRequired':
      return 'This image requires a membership upgrade to view. Upgrade your membership to unlock it.';
    case 'enableNsfw':
      return 'This image was rated mature. Enable mature content in your settings to view it.';
    case 'NsfwLevel':
    case 'NSFWLevel':
      return 'One or more resources used here cannot generate mature content. Try a different model or a tamer prompt.';
    case 'NSFWLevelSourceImageRestricted':
      return 'Source image lacks valid metadata, so generation is restricted to PG / PG-13. Use a clean source image to lift the restriction.';
    default:
      return `Generation failed: ${blockedReason}.`;
  }
}
