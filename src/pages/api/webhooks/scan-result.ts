import { ModelFileType, ScanResultCode } from '@prisma/client';
import { z } from 'zod';
import { WebhookEndpoint } from '~/server/common/endpoint-helpers';
import { prisma } from '~/server/db/client';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { modelVersionId, type } = querySchema.parse(req.query);
  const scanResult: ScanResult = req.body;

  const where = { modelVersionId_type: { modelVersionId, type } };
  const file = await prisma.modelFile.findUnique({ where });
  if (!file) return res.status(404).json({ error: 'File not found' });

  const pickleScanMessage = preparePickleScanMessage(scanResult);

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
  picklescanGlobalImports: string[];
  picklescanDangerousImports: string[];
  clamscanExitCode: ScanExitCode;
  clamscanOutput: string;
};

const querySchema = z.object({
  modelVersionId: z.number(),
  type: z.nativeEnum(ModelFileType),
});

function processImport(importStr: string) {
  importStr = decodeURIComponent(importStr);
  const importParts = importStr.split(',').map((x) => x.replace(/'/g, '').trim());
  return importParts.join('.');
}

function preparePickleScanMessage({
  picklescanDangerousImports,
  picklescanGlobalImports,
}: ScanResult) {
  const importCount = picklescanDangerousImports.length + picklescanGlobalImports.length;
  if (importCount === 0) return 'No Pickle imports';

  const lines: string[] = [`**Detected Pickle imports (${importCount})**`];
  if (picklescanDangerousImports.length > 0) lines.push('*Dangerous import detected*');

  // Pre block with imports
  lines.push('```');
  for (const imp of picklescanDangerousImports) lines.push(`*${processImport(imp)}*`);
  for (const imp of picklescanGlobalImports) lines.push(processImport(imp));
  lines.push('```');

  return lines.join('\n');
}
