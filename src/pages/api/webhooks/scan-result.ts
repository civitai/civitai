import { ModelFileType, ScanResultCode } from '@prisma/client';
import { z } from 'zod';
import { WebhookEndpoint } from '~/server/common/endpoint-helpers';
import { prisma } from '~/server/db/client';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { modelVersionId: modelVersionIdString, type } = querySchema.parse(req.query);
  const modelVersionId = parseInt(modelVersionIdString);
  const scanResult: ScanResult = req.body;

  const where = { modelVersionId_type: { modelVersionId, type } };
  const file = await prisma.modelFile.findUnique({ where });
  if (!file) return res.status(404).json({ error: 'File not found' });

  const { hasDanger, pickleScanMessage } = examinePickleScanMessage(scanResult);
  if (hasDanger) scanResult.picklescanExitCode = ScanExitCode.Danger;

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
  modelVersionId: z.string(),
  type: z.nativeEnum(ModelFileType),
});

function processImport(importStr: string) {
  importStr = decodeURIComponent(importStr);
  const importParts = importStr.split(',').map((x) => x.replace(/'/g, '').trim());
  return importParts.join('.');
}

const specialImports: string[] = ['pytorch_lightning.callbacks.model_checkpoint.ModelCheckpoint'];

function examinePickleScanMessage({
  picklescanDangerousImports,
  picklescanGlobalImports,
}: ScanResult) {
  const importCount = picklescanDangerousImports.length + picklescanGlobalImports.length;
  if (importCount === 0)
    return {
      pickleScanMessage: 'No Pickle imports',
      hasDanger: false,
    };

  // Check for special imports...
  const dangerousGlobals = picklescanGlobalImports.filter((x) =>
    specialImports.includes(processImport(x))
  );
  for (const imp of dangerousGlobals) {
    picklescanDangerousImports.push(imp);
    picklescanGlobalImports.splice(picklescanDangerousImports.indexOf(imp), 1);
  }

  // Write message header...
  const lines: string[] = [`**Detected Pickle imports (${importCount})**`];
  const hasDanger = picklescanDangerousImports.length > 0;
  if (hasDanger) lines.push('*Dangerous import detected*');

  // Pre block with imports
  lines.push('```');
  for (const imp of picklescanDangerousImports) lines.push(`*${processImport(imp)}*`);
  for (const imp of picklescanGlobalImports) lines.push(processImport(imp));
  lines.push('```');

  return {
    pickleScanMessage: lines.join('\n'),
    hasDanger,
  };
}
