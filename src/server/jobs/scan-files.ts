import { ModelFileFormat, Prisma, ScanResultCode } from '@prisma/client';
import { S3Client } from '@aws-sdk/client-s3';
import dayjs from 'dayjs';

import { env } from '~/env/server.mjs';
import { prisma } from '~/server/db/client';
import { getGetUrl, getS3Client } from '~/utils/s3-utils';

import { createJob } from './job';
import { ModelFileType } from '~/server/common/constants';

export const scanFilesJob = createJob('scan-files', '*/5 * * * *', async () => {
  const scanCutOff = dayjs().subtract(1, 'day').toDate();
  const where: Prisma.ModelFileWhereInput = {
    virusScanResult: ScanResultCode.Pending,
    OR: [{ scanRequestedAt: null }, { scanRequestedAt: { lt: scanCutOff } }],
  };

  const files = await prisma.modelFile.findMany({
    where,
    select: { modelVersionId: true, type: true, url: true, format: true },
  });

  const s3 = getS3Client();
  for (const file of files) await requestFileScan(file, s3);

  await prisma.modelFile.updateMany({
    where,
    data: {
      scanRequestedAt: new Date(),
    },
  });
});

async function requestFileScan(
  { modelVersionId, type, format, url: s3Url }: FileScanRequest,
  s3: S3Client
) {
  const callbackUrl =
    `${env.NEXTAUTH_URL}/api/webhooks/scan-result?` +
    new URLSearchParams({
      modelVersionId: modelVersionId.toString(),
      type,
      format,
      token: env.WEBHOOK_TOKEN,
    });

  let fileUrl = s3Url;
  if (s3Url.includes(env.S3_UPLOAD_BUCKET)) {
    ({ url: fileUrl } = await getGetUrl(s3Url, { s3, expiresIn: 7 * 24 * 60 * 60 }));
  }

  const scanUrl =
    env.SCANNING_ENDPOINT +
    '?' +
    new URLSearchParams({
      token: env.SCANNING_TOKEN,
      fileUrl,
      callbackUrl,
    });

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
