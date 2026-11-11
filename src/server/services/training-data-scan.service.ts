import type { WorkflowStepTemplate } from '@civitai/orchestration-client';
import { submitWorkflow } from '@civitai/orchestration-client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { blobAir, uploadConsumerBlob } from '~/server/services/orchestrator/consumer-blob-scan';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { resolveDownloadUrl } from '~/utils/delivery-worker';
import { ScanResultCode } from '~/shared/utils/prisma/enums';

/**
 * The virus scan for a Training Data zip. The zip is copied to the orchestrator as a consumer blob
 * and scanned there; the scan-result webhook (`processModelFileScanResult`) writes its verdict to the
 * file's `virusScanResult`. Until that verdict is a Success, the zip is served to no one but its
 * owner and moderators (`getFileForModelVersion`).
 *
 * Training Data never goes through the model-file AIR scan: that scan fetches the file through the
 * public download route, which refuses an unscanned zip.
 */

/** `metadata.scan` on the workflow: tells the webhook a clean result must have read files. */
export const TRAINING_DATA_BLOB_SCAN = 'training-data-blob';

/** For the zip's storage to answer; the copy itself is bounded by the upload deadline. */
const SOURCE_RESPONSE_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const SUBMIT_TIMEOUT_MS = 60_000;

export type TrainingDataScanTarget = {
  fileId: number;
  modelVersionId: number;
  /** The file's stored url, as the resolver knows it. */
  url: string;
};

/**
 * Submits one Training Data file to the scan. Throws when it could not be submitted; the file stays
 * Pending. Outside production without an orchestrator token nothing is submitted and the file stays
 * Pending: a scan is never faked.
 */
export async function submitTrainingDataScan({
  fileId,
  modelVersionId,
  url,
}: TrainingDataScanTarget) {
  if (!isProd && !env.ORCHESTRATOR_ACCESS_TOKEN) return;

  await dbWrite.modelFile.update({
    where: { id: fileId },
    data: { scanRequestedAt: new Date() },
  });

  const { url: sourceUrl } = await resolveDownloadUrl(fileId, url, undefined, {
    caller: 'training-data',
    actor: 'internal',
  });
  const answered = new AbortController();
  const noAnswer = setTimeout(() => answered.abort(), SOURCE_RESPONSE_TIMEOUT_MS);
  const source = await fetch(sourceUrl, {
    signal: AbortSignal.any([answered.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
  }).finally(() => clearTimeout(noAnswer));
  const size = Number(source.headers.get('content-length'));
  if (!source.ok || !source.body || !(size > 0))
    throw new Error(`Training data source unreadable: ${source.status}`);

  const air = blobAir(
    await uploadConsumerBlob({ body: source.body, size, timeoutMs: UPLOAD_TIMEOUT_MS })
  );
  // The url ties the verdict to these bytes: the webhook drops it once the file holds another zip.
  const metadata = { fileId, modelVersionId, url, scan: TRAINING_DATA_BLOB_SCAN };
  const { data } = await submitWorkflow({
    client: internalOrchestratorClient,
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    body: {
      metadata,
      currencies: [],
      tags: ['civitai', 'training-data-scan'],
      steps: [
        {
          $type: 'modelClamScan',
          name: 'clamScan',
          metadata,
          input: { model: air },
        } as WorkflowStepTemplate,
      ],
      callbacks: [
        {
          url: `${env.NEXTAUTH_URL}/api/webhooks/model-file-scan-result?token=${env.WEBHOOK_TOKEN}`,
          type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
        },
      ],
    },
  });
  if (!data?.id) throw new Error(`Training data scan was not accepted for file ${fileId}`);
}

/** As `submitTrainingDataScan`, for a caller that must not fail on it: the failure is logged. */
export async function submitTrainingDataScanSafe(
  target: TrainingDataScanTarget,
  op: string
): Promise<boolean> {
  try {
    await submitTrainingDataScan(target);
    return true;
  } catch (error) {
    logToAxiom({
      ...safeError(error),
      type: 'error',
      name: 'training-data-scan-submit',
      op,
      fileId: target.fileId,
      modelVersionId: target.modelVersionId,
    }).catch(() => undefined);
    return false;
  }
}

/** A Training Data zip still waiting for a verdict. A Studio placeholder (0 bytes) has no zip yet. */
const pendingTrainingDataWhere: Prisma.ModelFileWhereInput = {
  type: 'Training Data',
  virusScanResult: ScanResultCode.Pending,
  sizeKB: { gt: 0 },
  OR: [{ exists: null }, { exists: true }],
};

const REQUEUE_CONCURRENCY = 3;
/** A zip submitted this recently may still be copying or scanning. */
const REQUEUE_IN_FLIGHT_MS = 60 * 60_000;

/**
 * Submits one page of the Pending Training Data zips, oldest first, to the scan, skipping any
 * submitted within the last hour. With `dryRun` it submits nothing. `total` counts every Pending zip.
 */
export async function requeuePendingTrainingDataScans({
  limit,
  afterId,
  dryRun,
}: {
  limit: number;
  afterId?: number;
  dryRun: boolean;
}) {
  const where: Prisma.ModelFileWhereInput = {
    ...pendingTrainingDataWhere,
    AND: [
      {
        OR: [
          { scanRequestedAt: null },
          { scanRequestedAt: { lt: new Date(Date.now() - REQUEUE_IN_FLIGHT_MS) } },
        ],
      },
    ],
    ...(afterId !== undefined && { id: { gt: afterId } }),
  };
  const [total, files] = await Promise.all([
    dbWrite.modelFile.count({ where: pendingTrainingDataWhere }),
    dbWrite.modelFile.findMany({
      where,
      select: { id: true, url: true, modelVersionId: true },
      orderBy: { id: 'asc' },
      take: limit,
    }),
  ]);
  const nextAfterId = files.length === limit ? files[files.length - 1].id : null;
  if (dryRun) return { dryRun, total, page: files.length, nextAfterId };

  let submitted = 0;
  const failed: number[] = [];
  await limitConcurrency(
    files.map((file) => async () => {
      const ok = await submitTrainingDataScanSafe(
        { fileId: file.id, modelVersionId: file.modelVersionId, url: file.url },
        'requeue'
      );
      if (ok) submitted++;
      else failed.push(file.id);
    }),
    REQUEUE_CONCURRENCY
  );
  return { dryRun, total, page: files.length, submitted, failed, nextAfterId };
}
