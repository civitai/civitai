import { ModelFileType, ScanResultCode } from '@prisma/client';
import { z } from 'zod';
import { WebhookEndpoint } from '~/server/common/endpoint-helpers';
import { prisma } from '~/server/db/client';

enum ScanExitCode {
  Success = 0,
  Danger = 1,
  Error = 2,
}

const resultCodeMap = {
  [ScanExitCode.Success]: ScanResultCode.Success,
  [ScanExitCode.Danger]: ScanResultCode.Danger,
  [ScanExitCode.Error]: ScanResultCode.Error,
};

type ScanResult = {
  url: string;
  picklescanExitCode: ScanExitCode;
  picklescanOutput: string;
  clamscanExitCode: ScanExitCode;
  clamscanOutput: string;
};

const querySchema = z.object({
  modelVersionId: z.number(),
  type: z.nativeEnum(ModelFileType),
});

function preparePickleScanMessage(picklescanExitCode: ScanExitCode, scanMessage: string) {
  return '';
}

export default WebhookEndpoint(async (req, res) => {
  const { modelVersionId, type } = querySchema.parse(req.query);
  const scanResult: ScanResult = req.body;

  const where = { modelVersionId_type: { modelVersionId, type } };
  const file = await prisma.modelFile.findUnique({ where });
  if (!file) return res.status(404).json({ error: 'File not found' });

  const pickleScanMessage = preparePickleScanMessage(
    scanResult.picklescanExitCode,
    scanResult.picklescanOutput
  );

  await prisma.modelFile.update({
    where,
    data: {
      scannedAt: new Date(),
      rawScanResult: scanResult,
      virusScanResult: resultCodeMap[scanResult.clamscanExitCode],
      virusScanMessage:
        scanResult.clamscanExitCode != ScanExitCode.Success ? scanResult.clamscanOutput : null,
      pickleScanResult: resultCodeMap[scanResult.picklescanExitCode],
      pickleScanMessage,
    },
  });

  res.status(200).json({ ok: true });
});
