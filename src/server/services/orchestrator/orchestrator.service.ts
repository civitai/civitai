import type { Priority, WorkflowStepTemplate, XGuardModerationStepTemplate } from '@civitai/client';
import { submitWorkflow } from '@civitai/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbWrite } from '~/server/db/client';
import { env } from '~/env/server';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import type { MediaType, ModelType } from '~/shared/utils/prisma/enums';
import { ModelHashType, ScanResultCode } from '~/shared/utils/prisma/enums';
import { stringifyAIR } from '~/shared/utils/air';
import { resolveDownloadUrl } from '~/utils/delivery-worker';

export async function createImageIngestionRequest({
  imageId,
  url,
  callbackUrl,
  wait,
  priority = 'normal',
  type = 'image',
}: {
  imageId: number;
  url: string;
  callbackUrl?: string;
  wait?: number;
  priority?: Priority;
  type?: MediaType;
}) {
  const metadata = { imageId };
  const edgeUrl = getEdgeUrl(url, { type });

  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: wait ? { wait } : undefined,
    body: {
      metadata,
      arguments: {
        mediaUrl: edgeUrl,
      },
      currencies: [],
      steps:
        type === 'image'
          ? [
              {
                $type: 'wdTagging',
                name: 'tags',
                metadata,
                priority,
                input: {
                  mediaUrl: { $ref: '$arguments', path: 'mediaUrl' },
                  model: 'wd14-vit.v1',
                  threshold: 0.5,
                },
              } as WorkflowStepTemplate,
              {
                $type: 'mediaRating',
                name: 'rating',
                metadata,
                priority,
                input: {
                  mediaUrl: { $ref: '$arguments', path: 'mediaUrl' },
                  engine: 'civitai',
                },
              } as WorkflowStepTemplate,
              {
                $type: 'mediaHash',
                name: 'hash',
                metadata,
                priority,
                input: {
                  mediaUrl: { $ref: '$arguments', path: 'mediaUrl' },
                  hashTypes: ['perceptual'],
                },
              } as WorkflowStepTemplate,
            ]
          : [
              {
                $type: 'videoFrameExtraction',
                name: 'videoFrames',
                metadata,
                priority,
                input: {
                  videoUrl: { $ref: '$arguments', path: 'mediaUrl' },
                  frameRate: 1,
                  uniqueThreshold: 0.9,
                  maxFrames: 50,
                },
              } as WorkflowStepTemplate,
              {
                $type: 'repeat',
                input: {
                  for: {
                    $ref: 'videoFrames',
                    path: 'output.frames',
                    as: 'frame',
                  },
                  template: {
                    $type: 'wdTagging',
                    name: 'tags',
                    metadata,
                    priority,
                    input: {
                      mediaUrl: {
                        $ref: 'frame',
                        path: 'url',
                      },
                      model: 'wd14-vit.v1',
                      threshold: 0.5,
                    },
                  },
                },
              } as WorkflowStepTemplate,
              {
                $type: 'repeat',
                input: {
                  for: {
                    $ref: 'videoFrames',
                    path: 'output.frames',
                    as: 'frame',
                  },
                  template: {
                    $type: 'mediaRating',
                    name: 'rating',
                    metadata,
                    priority,
                    input: {
                      mediaUrl: {
                        $ref: 'frame',
                        path: 'url',
                      },
                      engine: 'civitai',
                    },
                  },
                },
              } as WorkflowStepTemplate,
            ],
      callbacks: callbackUrl
        ? [
            {
              url: `${callbackUrl}`,
              type: [
                'workflow:succeeded',
                'workflow:failed',
                'workflow:expired',
                'workflow:canceled',
              ],
            },
          ]
        : undefined,
    },
  });

  const serverTiming = response.headers.get('Server-Timing');

  if (!data) {
    logToAxiom({
      type: 'error',
      name: 'image-ingestion',
      imageId,
      url,
      responseStatus: response.status,
      serverTiming,
      error,
    });
  }

  return data;
}

export async function createTextModerationRequest({
  entityType,
  entityId,
  content,
  labels,
  callbackUrl,
  wait,
  priority = 'normal',
}: {
  entityType: string;
  entityId: number;
  content: string;
  labels?: string[];
  callbackUrl?: string;
  wait?: number;
  priority?: Priority;
}) {
  const metadata = { entityType, entityId };

  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: wait ? { wait } : undefined,
    body: {
      metadata,
      currencies: [],
      steps: [
        {
          $type: 'xGuardModeration',
          name: 'textModeration',
          metadata,
          priority,
          input: {
            text: content,
            mode: 'text',
            labels,
            storeFullResponse: false,
          },
        } as XGuardModerationStepTemplate,
      ],
      callbacks: callbackUrl
        ? [
            {
              url: `${callbackUrl}`,
              type: [
                'workflow:succeeded',
                'workflow:failed',
                'workflow:expired',
                'workflow:canceled',
              ],
            },
          ]
        : undefined,
    },
  });

  const serverTiming = response?.headers?.get('Server-Timing');

  if (!data) {
    logToAxiom({
      type: 'error',
      name: 'text-moderation',
      entityType,
      entityId,
      responseStatus: response?.status,
      serverTiming,
      error,
    });
  }

  return data;
}

/**
 * Thrown by createModelFileScanRequest when submission can't proceed. The
 * `code` lets callers branch their recovery:
 *   - 'not-found': pre-flight download-URL resolution failed twice (storage
 *     resolver + delivery worker both can't locate the file). Caller should
 *     mark ModelFile.exists=false to exit the scan retry loop.
 *   - 'transient': submitWorkflow itself failed (5xx, network, auth, etc.).
 *     Caller should leave `exists` alone and rely on retry.
 *
 * Why pre-flight (not orchestrator response): submitWorkflow only enqueues —
 * orchestrator validates the AIR-fetchable file later, asynchronously, in
 * the workflow steps themselves. There's no synchronous "file missing"
 * signal at submit time. So we mirror legacy `requestScannerTasks`: resolve
 * the download URL ourselves before submitting, and treat resolution failure
 * as the file-gone signal.
 */
export class ModelFileScanSubmissionError extends Error {
  constructor(
    message: string,
    public readonly code: 'not-found' | 'transient',
    public readonly status?: number,
    public readonly orchestratorMessages?: string[]
  ) {
    super(message);
    this.name = 'ModelFileScanSubmissionError';
  }
}

export async function createModelFileScanRequest({
  fileId,
  modelVersionId,
  modelId,
  modelType,
  baseModel,
  url,
  preflight = true,
  priority = 'normal',
}: {
  fileId: number;
  modelVersionId: number;
  modelId: number;
  modelType: ModelType;
  baseModel: string;
  /** S3 URL for the file. Used by the pre-flight download-URL resolver to
   * confirm the file exists before submitting a workflow. */
  url: string;
  /** Default true. Pass false from `createFileHandler` (inline post-upload)
   * to avoid a possible 60s sync-lag retry blocking the upload response —
   * the file just landed, so existence is near-certain, and if it really
   * is missing the 5-min `scanFilesFallbackJob` will catch and tombstone it. */
  preflight?: boolean;
  priority?: Priority;
}) {
  // Dev skip: only when BOTH (a) we're in non-prod AND (b) no token is
  // configured. In prod a missing token MUST surface as a real submitWorkflow
  // failure — we never silently fake-success virus scans. In non-prod with a
  // configured token, we still want real submissions so the new flow can be
  // tested locally against a dev orchestrator.
  if (!isProd && !env.ORCHESTRATOR_ACCESS_TOKEN) {
    console.log('skipping orchestrator scan in non-prod without access token');
    const now = new Date();
    await dbWrite.modelFile.update({
      where: { id: fileId },
      data: {
        scanRequestedAt: now,
        scannedAt: now,
        virusScanResult: ScanResultCode.Success,
        pickleScanResult: ScanResultCode.Success,
      },
    });
    await dbWrite.modelFileHash.upsert({
      where: { fileId_type: { fileId, type: ModelHashType.SHA256 } },
      create: { fileId, type: ModelHashType.SHA256, hash: '0'.repeat(64) },
      update: { hash: '0'.repeat(64) },
    });
    return;
  }

  // Pre-flight: confirm the file is actually fetchable before submitting an
  // orchestrator workflow. Mirrors legacy `requestScannerTasks` (`scan-files.ts`):
  //
  //   1) try storage-resolver / delivery-worker (resolveDownloadUrl)
  //   2) on failure, wait 60s and retry once (covers registration sync lag
  //      for recently-uploaded files)
  //   3) on second failure, throw 'not-found' so the caller can tombstone
  //
  // This is the file-gone signal we used in the legacy scanner; orchestrator
  // submitWorkflow doesn't surface one synchronously.
  if (preflight) {
    try {
      await resolveDownloadUrl(fileId, url);
    } catch (firstError) {
      await new Promise((r) => setTimeout(r, 60_000));
      try {
        await resolveDownloadUrl(fileId, url);
      } catch (retryError) {
        logToAxiom({
          type: 'error',
          name: 'model-file-scan',
          message: `Pre-flight download URL resolution failed for file ${fileId}`,
          fileId,
          modelVersionId,
          submissionErrorCode: 'not-found',
          firstError: firstError instanceof Error ? firstError.message : String(firstError),
          retryError: retryError instanceof Error ? retryError.message : String(retryError),
        });
        throw new ModelFileScanSubmissionError(
          `Pre-flight resolution failed for file ${fileId}; treating as not-found`,
          'not-found'
        );
      }
    }
  }

  const air = stringifyAIR({
    baseModel,
    type: modelType,
    modelId,
    id: modelVersionId,
    fileId,
  });

  const metadata = { fileId, modelVersionId };
  const callbackUrl = `${env.NEXTAUTH_URL}/api/webhooks/model-file-scan-result?token=${env.WEBHOOK_TOKEN}`;

  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    body: {
      metadata,
      currencies: [],
      tags: ['civitai', 'model-scan'],
      steps: [
        {
          $type: 'modelClamScan',
          name: 'clamScan',
          metadata,
          priority,
          input: { model: air },
        } as WorkflowStepTemplate,
        {
          $type: 'modelPickleScan',
          name: 'pickleScan',
          metadata,
          priority,
          input: { model: air },
        } as WorkflowStepTemplate,
        {
          $type: 'modelHash',
          name: 'hash',
          metadata,
          priority,
          input: { model: air },
        } as WorkflowStepTemplate,
        {
          $type: 'modelParseMetadata',
          name: 'parseMetadata',
          metadata,
          priority,
          input: { model: air },
        } as WorkflowStepTemplate,
      ],
      callbacks: [
        {
          url: callbackUrl,
          type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
        },
      ],
    },
  });

  if (!data) {
    // submitWorkflow only enqueues — orchestrator can't tell us the file is
    // missing here (that surfaces later in the workflow steps). Anything that
    // gets us here is transient: 5xx, network, auth, malformed payload. The
    // caller's retry policy applies; 'not-found' is reserved for the
    // pre-flight resolution-failure path above.
    logToAxiom({
      type: 'error',
      name: 'model-file-scan',
      fileId,
      modelVersionId,
      air,
      responseStatus: response.status,
      submissionErrorCode: 'transient',
      error,
    });

    throw new ModelFileScanSubmissionError(
      `Failed to submit model file scan workflow for file ${fileId}` +
        (response?.status ? ` (status ${response.status})` : ''),
      'transient',
      response?.status
    );
  }

  // Mark the file as in-flight so concurrent paths (scanFilesFallbackJob's
  // next tick, an overlapping rescan, etc.) don't double-submit while the
  // orchestrator works on it. The webhook callback will set scannedAt later.
  await dbWrite.modelFile.update({
    where: { id: fileId },
    data: { scanRequestedAt: new Date() },
  });

  return data;
}
