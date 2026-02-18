import type { Prisma } from '@prisma/client';
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

  const sent: number[] = [];
  const failed: number[] = [];
  for (const file of files) {
    const success = await requestScannerTasks({ file });
    if (success) sent.push(file.id);
    else failed.push(file.id);
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
}: ScannerRequest) {
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
    return true;
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
  try {
    if (isStorageResolverEnabled()) {
      ({ url: fileUrl } = await getDownloadUrlByFileId(fileId));
    } else {
      ({ url: fileUrl } = await getDownloadUrl(s3Url));
    }
  } catch (error) {
    // Storage-resolver may not have this file yet (sync lag for recently uploaded files).
    // Fall back to delivery worker using the S3 URL directly.
    try {
      ({ url: fileUrl } = await getDownloadUrl(s3Url));
    } catch (fallbackError) {
      logToAxiom(
        {
          type: 'error',
          name: 'request-scanner-tasks',
          message: `Failed to get download url for file ${fileId} (${fileUrl})`,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          stack: fallbackError instanceof Error ? fallbackError.stack : undefined,
        },
        'webhooks'
      ).catch();
      console.error(`Failed to get download url for file ${fileId} (${fileUrl})`);
      return false;
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

  await fetch(scanUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  return true;
}

type FileScanRequest = {
  id: number;
  url: string;
};

export const ScannerTasks = ['Import', 'Hash', 'Scan', 'Convert', 'ParseMetadata'] as const;
export type ScannerTask = (typeof ScannerTasks)[number];
