import type { Prisma } from '@prisma/client';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { ScanResultCode } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';

import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';

import { createJob } from './job';
import {
  getDownloadUrl,
  getDownloadUrlByFileId,
  isStorageResolverEnabled,
} from '~/utils/delivery-worker';
import { logToAxiom } from '~/server/logging/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { createModelFileScanRequest } from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export const scanFilesJob = createJob('scan-files', '*/5 * * * *', async () => {
  // When the orchestrator path is enabled, the new scanFilesFallbackJob handles
  // pending files. Skip the legacy poll to avoid double-submitting.
  if (await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_FILE_SCAN_ORCHESTRATOR)) return;

  const scanCutOff = dayjs().subtract(1, 'day').toDate();
  const where: Prisma.ModelFileWhereInput = {
    virusScanResult: ScanResultCode.Pending,
    AND: [
      { OR: [{ exists: null }, { exists: true }] },
      { OR: [{ scanRequestedAt: null }, { scanRequestedAt: { lt: scanCutOff } }] },
    ],
  };

  const files = await dbWrite.modelFile.findMany({
    where,
    select: { id: true, url: true },
  });

  const sent: number[] = [];
  const failed: number[] = [];
  for (const file of files) {
    const result = await requestScannerTasks({ file });
    if (result === 'sent') sent.push(file.id);
    else if (result === 'not-found') failed.push(file.id);
    // 'error' = scanner issue, don't mark as non-existent, just skip
  }

  // Mark sent as requested
  await dbWrite.modelFile.updateMany({
    where: { id: { in: sent } },
    data: { scanRequestedAt: new Date() },
  });

  // Mark failed doesn't exist
  await dbWrite.modelFile.updateMany({
    where: { id: { in: failed } },
    data: { exists: false },
  });
});

type ScannerRequest = {
  file: FileScanRequest;
  tasks?: ScannerTask[] | ScannerTask;
  lowPriority?: boolean;
};

export async function requestScannerTasks({
  file: { id: fileId, url: s3Url },
  tasks = ['Scan', 'Hash', 'ParseMetadata'],
  lowPriority = false,
}: ScannerRequest): Promise<'sent' | 'not-found' | 'error'> {
  if (!env.SCANNING_ENDPOINT) {
    console.log('Skipping file scanning');
    const today = new Date();
    // Mark as scanned
    await dbWrite.modelFile.update({
      where: { id: fileId },
      data: {
        scanRequestedAt: today,
        scannedAt: today,
        virusScanResult: ScanResultCode.Success,
        pickleScanResult: ScanResultCode.Success,
      },
    });
    // Create fake hash
    await dbWrite.modelFileHash.create({ data: { fileId, type: 'SHA256', hash: '0'.repeat(64) } });
    return 'sent';
  }

  if (!Array.isArray(tasks)) tasks = [tasks];

  const callbackUrl =
    `${env.NEXTAUTH_URL}/api/webhooks/scan-result?` +
    new URLSearchParams([
      ['fileId', fileId.toString()],
      ['token', env.WEBHOOK_TOKEN],
      ...tasks.map((task) => ['tasks', task]),
    ]);

  let fileUrl = s3Url;
  const resolveFileUrl = async () => {
    if (isStorageResolverEnabled()) {
      return (await getDownloadUrlByFileId(fileId)).url;
    }
    return (await getDownloadUrl(s3Url)).url;
  };

  try {
    fileUrl = await resolveFileUrl();
  } catch (error) {
    // Storage-resolver may not have this file yet (sync lag for recently uploaded files).
    // Fall back to delivery worker using the S3 URL directly.
    try {
      ({ url: fileUrl } = await getDownloadUrl(s3Url));
    } catch {
      // Both failed — wait 60s and retry once (covers registration sync lag)
      await new Promise((r) => setTimeout(r, 60_000));
      try {
        fileUrl = await resolveFileUrl();
      } catch (retryError) {
        logToAxiom(
          {
            type: 'error',
            name: 'request-scanner-tasks',
            message: `Failed to get download url for file ${fileId} (${s3Url})`,
            error: retryError instanceof Error ? retryError.message : String(retryError),
            stack: retryError instanceof Error ? retryError.stack : undefined,
          },
          'webhooks'
        ).catch();
        console.error(`Failed to get download url for file ${fileId} (${s3Url})`);
        return 'not-found';
      }
    }
  }

  const scanUrl =
    env.SCANNING_ENDPOINT +
    '?' +
    new URLSearchParams([
      ['token', env.SCANNING_TOKEN],
      ['callbackUrl', callbackUrl],
      ['fileUrl', fileUrl],
      ...(lowPriority ? [['lowPrio', 'true']] : []),
      ...tasks.map((task) => ['tasks', task]),
    ]);

  try {
    const res = await fetch(scanUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'unable to read response body');
      logToAxiom(
        {
          type: 'error',
          name: 'request-scanner-tasks',
          message: `Scanner rejected request for file ${fileId}`,
          status: res.status,
          statusText: res.statusText,
          responseBody: body,
        },
        'webhooks'
      ).catch();
      console.error(`Scanner rejected request for file ${fileId}: ${res.status} ${res.statusText}`);
      return 'error';
    }
  } catch (error) {
    logToAxiom(
      {
        type: 'error',
        name: 'request-scanner-tasks',
        message: `Failed to send scan request for file ${fileId}`,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'webhooks'
    ).catch();
    console.error(`Failed to send scan request for file ${fileId}:`, error);
    return 'error';
  }

  return 'sent';
}

type FileScanRequest = {
  id: number;
  url: string;
};

export const ScannerTasks = ['Import', 'Hash', 'Scan', 'Convert', 'ParseMetadata'] as const;
export type ScannerTask = (typeof ScannerTasks)[number];

// Fallback job: resubmits orchestrator scan workflows for files that were missed
// or whose scans stalled. Runs every 5 minutes, picks up files where:
// - virusScanResult is still Pending
// - scanRequestedAt is null (never submitted) or older than 1 day (stalled)
const SCAN_FALLBACK_CONCURRENCY = 10;
const SCAN_FALLBACK_BATCH_SIZE = 200;

export const scanFilesFallbackJob = createJob('scan-files-fallback', '*/5 * * * *', async () => {
  // Mirrors the legacy scanFilesJob gate, inverted: this is the orchestrator
  // path and only runs when the flag is ON.
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_FILE_SCAN_ORCHESTRATOR))) return;

  const scanCutOff = dayjs().subtract(1, 'day').toDate();

  const files = await dbWrite.modelFile.findMany({
    where: {
      virusScanResult: ScanResultCode.Pending,
      AND: [
        { OR: [{ exists: null }, { exists: true }] },
        { OR: [{ scanRequestedAt: null }, { scanRequestedAt: { lt: scanCutOff } }] },
      ],
    },
    select: {
      id: true,
      modelVersion: {
        select: {
          id: true,
          baseModel: true,
          model: { select: { id: true, type: true } },
        },
      },
    },
    take: SCAN_FALLBACK_BATCH_SIZE,
  });

  if (files.length === 0) return { submitted: 0 };

  // Mark batch as requested upfront so overlapping runs won't re-process
  await dbWrite.modelFile.updateMany({
    where: { id: { in: files.map((f) => f.id) } },
    data: { scanRequestedAt: new Date() },
  });

  let submitted = 0;
  let failed = 0;
  await limitConcurrency(
    files.map((file) => async () => {
      // Defensive: a soft-deleted ModelVersion would null this out and crash
      // the whole batch. Skip and count as failed instead.
      if (!file.modelVersion) {
        failed++;
        await dbWrite.modelFile
          .update({ where: { id: file.id }, data: { scanRequestedAt: null } })
          .catch(() => null);
        return;
      }
      try {
        await createModelFileScanRequest({
          fileId: file.id,
          modelVersionId: file.modelVersion.id,
          modelId: file.modelVersion.model.id,
          modelType: file.modelVersion.model.type as ModelType,
          baseModel: file.modelVersion.baseModel,
          priority: 'low',
        });
        submitted++;
      } catch (err) {
        failed++;
        // Reset scanRequestedAt so the next 5-min tick retries this file.
        // Without this, the upfront updateMany above would leave it Pending
        // for the 24h stale-cutoff window — too long for transient
        // orchestrator outages, which are the common case for submission
        // failures (vs. workflow-level failures handled by D4).
        await dbWrite.modelFile
          .update({ where: { id: file.id }, data: { scanRequestedAt: null } })
          .catch(() => null);
        logToAxiom(
          {
            type: 'error',
            name: 'scan-files-fallback',
            message: `Failed to submit scan workflow for file ${file.id}`,
            error: err instanceof Error ? err.message : String(err),
          },
          'webhooks'
        ).catch();
      }
    }),
    SCAN_FALLBACK_CONCURRENCY
  );

  return { submitted, failed };
});
