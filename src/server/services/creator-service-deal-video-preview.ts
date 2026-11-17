import { handleError, submitWorkflow } from '@civitai/orchestration-client';
import type {
  Blob as OrchestratorBlob,
  TranscodeStepTemplate,
  WorkflowTemplate,
} from '@civitai/orchestration-client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { getConsumerBlobUploadUrlService } from '~/server/services/orchestrator/consumerBlobUpload';
import { PreviewRejectedError, watermarkTilePng } from '~/server/utils/service-deal-preview';
import {
  SERVICE_PREVIEW_VIDEO_MAX_SECONDS,
  SERVICE_PREVIEW_VIDEO_WIDTH,
} from '~/shared/constants/creator-services.constants';

const TRANSCODE_WAIT_SECONDS = 90;

function videoPreviewWorkflow(sourceUrl: string, tile: Buffer): WorkflowTemplate {
  const step: TranscodeStepTemplate = {
    $type: 'transcode',
    input: {
      sourceUrl,
      width: SERVICE_PREVIEW_VIDEO_WIDTH,
      maxDuration: SERVICE_PREVIEW_VIDEO_MAX_SECONDS,
      hideMetadata: true,
      watermark: {
        image: `data:image/png;base64,${tile.toString('base64')}`,
        opacity: 0.35,
        scale: 0.3,
        angle: 30,
      },
    },
  };
  return { tags: ['creator-service-preview'], currencies: [], steps: [step] };
}

// The transcode fails on a plain https source; it reads its own blobs. The seller's media goes up
// under the seller's token, as every consumer upload does. A muted seller can still deliver.
async function uploadSourceBlob(data: Buffer, mimeType: string, sellerId: number) {
  const token = await getOrchestratorToken(sellerId, undefined, { allowRestricted: true });
  const presign = await getConsumerBlobUploadUrlService({ token });
  const response = await fetch(presign.uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': mimeType },
    body: new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
  });
  if (response.status === 400 || response.status === 415)
    throw new PreviewRejectedError('This video could not be read. Upload an MP4 or WebM file.');
  if (!response.ok) throw new Error(`Video preview blob upload failed: ${response.status}`);
  const blob = (await response.json()) as OrchestratorBlob;
  if (!blob.url) throw new Error('Video preview blob upload returned no url');
  return blob.url;
}

/**
 * The only thing a buyer sees of a video preview: the first seconds, scaled down, with the mark
 * burned into every frame. A transcode that fails is put on the file (the seller can upload
 * something else); one that has not finished within the wait throws, and the job retries it.
 */
export async function buildWatermarkedVideoPreview(
  original: Buffer,
  mimeType: string,
  sellerId: number
) {
  const sourceUrl = await uploadSourceBlob(original, mimeType, sellerId);
  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: TRANSCODE_WAIT_SECONDS },
    body: videoPreviewWorkflow(sourceUrl, await watermarkTilePng()),
  });
  if (!data)
    throw new Error(
      `Video preview submit failed: ${
        (error ? handleError(error) : undefined) ?? response?.statusText ?? 'unknown error'
      }`
    );

  const step = (data.steps ?? [])[0] as
    | { status?: string; output?: { url?: string | null } | null }
    | undefined;
  const status = step?.status ?? data.status;
  if (status === 'failed' || status === 'expired' || status === 'canceled')
    throw new PreviewRejectedError('This video could not be turned into a preview.');
  const url = step?.output?.url;
  if (status !== 'succeeded' || !url)
    throw new Error(`Video preview transcode not finished (status: ${status ?? 'unknown'})`);

  const output = await fetch(url);
  if (!output.ok) throw new Error(`Video preview download failed: ${output.status}`);
  return {
    data: Buffer.from(await output.arrayBuffer()),
    mimeType: 'video/mp4' as const,
    width: SERVICE_PREVIEW_VIDEO_WIDTH,
  };
}
