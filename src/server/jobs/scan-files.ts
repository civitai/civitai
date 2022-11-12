import { createJob } from './job';
import { prisma } from '~/server/db/client';
import { ScanResultCode } from '@prisma/client';
import dayjs from 'dayjs';
import { env } from '~/env/server.mjs';

export const scanFilesJob = createJob('scan-files', '*/5 * * * *', async () => {
  const scanCutOff = dayjs().subtract(1, 'day').toDate();
  const where = {
    virusScanResult: ScanResultCode.Pending,
    OR: [{ scanRequestedAt: null }, { scanRequestedAt: { lt: scanCutOff } }],
  };

  const files = await prisma.modelFile.findMany({
    where,
    select: { modelVersionId: true, type: true, url: true },
  });

  for (const file of files) await requestFileScan(file);

  await prisma.modelFile.updateMany({
    where,
    data: {
      scanRequestedAt: new Date(),
    },
  });
});

async function requestFileScan({ modelVersionId, type, url: fileUrl }: FileScanRequest) {
  const callbackUrl =
    `${env.NEXTAUTH_URL}/api/webhooks/scan-result` +
    new URLSearchParams({
      modelVersionId: modelVersionId.toString(),
      type: type.toString(),
    });

  const scanUrl =
    env.SCANNING_ENDPOINT +
    new URLSearchParams({
      fileUrl,
      callbackUrl,
    });

  const res = await fetch(scanUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  return res.json();
}

type FileScanRequest = {
  modelVersionId: number;
  type: ModelFileType;
  url: string;
};
