import { ModelFileFormat, Prisma, ScanResultCode } from '@prisma/client';
import { S3Client } from '@aws-sdk/client-s3';
import dayjs from 'dayjs';

import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { getGetUrl, getS3Client } from '~/utils/s3-utils';

import { createJob } from './job';

export const scanFilesJob = createJob('scan-files', '*/5 * * * *', async () => {
  const scanCutOff = dayjs().subtract(1, 'day').toDate();
  const where: Prisma.ModelFileWhereInput = {
    virusScanResult: ScanResultCode.Pending,
    OR: [{ scanRequestedAt: null }, { scanRequestedAt: { lt: scanCutOff } }],
  };

  const files = await dbWrite.modelFile.findMany({
    where,
    select: { modelVersionId: true, type: true, url: true, format: true },
  });

  const s3 = getS3Client();
  for (const file of files) await requestScannerTasks({ file, s3 });

  await dbWrite.modelFile.updateMany({
    where,
    data: {
      scanRequestedAt: new Date(),
    },
  });
});

type ScannerRequest = {
  file: FileScanRequest;
  s3: S3Client;
  tasks?: ScannerTask[] | ScannerTask;
  lowPriority?: boolean;
};

export async function requestScannerTasks({
  file: { modelVersionId, type, format, url: s3Url },
  s3,
  tasks = ['Import', 'Scan', 'Hash'],
  lowPriority = false,
}: ScannerRequest) {
  if (!Array.isArray(tasks)) tasks = [tasks];

  const callbackUrl =
    `${env.NEXTAUTH_URL}/api/webhooks/scan-result?` +
    new URLSearchParams([
      ['modelVersionId', modelVersionId.toString()],
      ['type', type],
      ['format', format],
      ['token', env.WEBHOOK_TOKEN],
      ...tasks.map((task) => ['tasks', task]),
    ]);

  let fileUrl = s3Url;
  if (s3Url.includes(env.S3_UPLOAD_BUCKET) || s3Url.includes(env.S3_SETTLED_BUCKET)) {
    ({ url: fileUrl } = await getGetUrl(s3Url, { s3, expiresIn: 7 * 24 * 60 * 60 }));
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
}

type FileScanRequest = {
  modelVersionId: number;
  type: string;
  format: ModelFileFormat;
  url: string;
};

export const ScannerTasks = ['Import', 'Hash', 'Scan', 'Convert'] as const;
export type ScannerTask = typeof ScannerTasks[number];
