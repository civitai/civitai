import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getImageUploadBackend } from '~/utils/s3-utils';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { createImage } from '~/server/services/image.service';
import { registerMediaLocation } from '~/server/services/storage-resolver';
import { recordUploadKeyOwner } from '~/server/services/image-url-ownership';
import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';
import { sanitizeStepErrors } from './provider-errors';
import { formatGenerationResponse2 } from '~/server/services/orchestrator/orchestration-new.service';
import { WorkflowData } from '~/shared/orchestrator/workflow-data';
import { colorDomainNames, type ColorDomain } from '~/shared/constants/domain.constants';
import { UNMARKED_SOURCE_IMAGE_MESSAGE } from '~/shared/constants/mature-source.constants';

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
    if (!imageResponse.ok) throw new Error(`Failed to download: ${imageResponse.status}`);
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
    await recordUploadKeyOwner(s3Key, userId);

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
  const succeeded = workflowStatus === 'succeeded' || stepStatus === 'succeeded';

  // Raw orchestrator output carries only its own blocks; the mature gates are derived by BlobData
  // from the rating, domain and viewer settings. Built only once succeeded: the formatter reads
  // resources on every call, and the client polls on an interval.
  let rawImages: any[] = firstStep?.output?.images ?? firstStep?.output?.blobs ?? [];
  if (succeeded) {
    const [normalized] = await formatGenerationResponse2([workflow as any], ctx?.user);
    const domainFlags = colorDomainNames.reduce(
      (acc, c) => ({ ...acc, [c]: c === ctx?.domain }),
      {} as Record<ColorDomain, boolean>
    );
    const wfData = new WorkflowData(normalized as any, {
      domain: domainFlags,
      nsfwEnabled: !!ctx?.user?.showNsfw,
      holdUnrated: true,
    });
    rawImages = wfData.steps[0]?.output ?? [];

    // Succeeded can precede the rating, and every gate below keys on it.
    if (rawImages.some((img) => img?.pendingRating))
      return { status: 'processing' as const, imageUrl: null, images: [] };
  }
  // The orchestrator writes 'none' for no block; WorkflowData already normalises it.
  const blocked = (img: any) => !!img?.blockedReason && img.blockedReason !== 'none';
  const outputImages: string[] = rawImages
    .filter((img) => !blocked(img))
    .map((img) => img?.url)
    .filter(Boolean) as string[];

  // A mature output on the SFW domain is `siteRestricted`. Hand off to a
  // mature-content domain so the user can use the workflow they already paid
  // for.
  if (
    succeeded &&
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

  // Any blocked reason on the output; `blockedReasonToMessage` turns it into the failure text.
  const blockedReason = rawImages.find(blocked)?.blockedReason as string | undefined;

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

  const engine =
    (firstStep?.metadata?.params as { engine?: string })?.engine ?? firstStep?.input?.engine;
  const providerErrors = sanitizeStepErrors(firstStep, engine);
  const providerErrorMessage = providerErrors.length > 0 ? providerErrors.join('\n') : undefined;

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
      errorMessage: blockedReasonToMessage(blockedReason) ?? providerErrorMessage,
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
      errorMessage: blockedReasonToMessage(blockedReason) ?? providerErrorMessage,
    };
  }

  // Still processing
  return { status: 'processing' as const, imageUrl: null, images: [] };
}

/** Map an output's blockedReason to plain text for the iterative editor, which has no unlock-in-place UI. */
function blockedReasonToMessage(blockedReason: string | undefined): string | undefined {
  if (!blockedReason) return undefined;
  switch (blockedReason) {
    case 'canUpgrade':
      return 'Mature content was generated. Open the Generator queue to unlock it with yellow Buzz — your Buzz is held, not lost.';
    case 'membershipRequired':
      return 'This image requires a membership upgrade to view. Upgrade your membership to unlock it.';
    case 'siteRestricted':
      return 'This image was rated mature and is not available on this site. Open it on civitai.red to use it.';
    case 'enableNsfw':
      return 'This image was rated mature. Enable mature content in your settings to view it.';
    case 'NsfwLevel':
    case 'NSFWLevel':
      return 'One or more resources used here cannot generate mature content. Try a different model or a tamer prompt.';
    case 'NSFWLevelSourceImageRestricted':
      return UNMARKED_SOURCE_IMAGE_MESSAGE;
    default:
      return `Generation failed: ${blockedReason}.`;
  }
}
