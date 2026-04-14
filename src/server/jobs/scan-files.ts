import type { Prisma } from '@prisma/client';
import { ScanResultCode } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';

import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';

import { createJob } from './job';
import {
  getDownloadUrl,
  getDownloadUrlByFileId,
  isStorageResolverEnabled,
} from '~/utils/delivery-worker';
import { logToAxiom } from '~/server/logging/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const SCAN_BATCH_SIZE = 200;
const SCAN_CONCURRENCY = 10;

export const scanFilesJob = createJob('scan-files', '*/5 * * * *', async () => {
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

  const batches = chunk(files, SCAN_BATCH_SIZE);
  for (const batch of batches) {
    const batchIds = batch.map((f) => f.id);

    // Mark batch as requested upfront so overlapping runs won't re-process
    await dbWrite.modelFile.updateMany({
      where: { id: { in: batchIds } },
      data: { scanRequestedAt: new Date() },
    });

    const failed: number[] = [];
    await limitConcurrency(
      batch.map((file) => async () => {
        const result = await requestScannerTasks({ file });
        if (result === 'not-found') failed.push(file.id);
        // 'error' = scanner issue, don't mark as non-existent, just skip
      }),
      SCAN_CONCURRENCY
    );

    // Mark failed as non-existent
    if (failed.length > 0) {
      await dbWrite.modelFile.updateMany({
        where: { id: { in: failed } },
        data: { exists: false },
      });
    }
  }
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
