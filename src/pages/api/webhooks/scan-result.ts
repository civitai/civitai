import { ModelFileType, ModelStatus, Prisma, ScanResultCode } from '@prisma/client';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { prisma } from '~/server/db/client';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { modelVersionId: modelVersionIdString, type } = querySchema.parse(req.query);
  const modelVersionId = parseInt(modelVersionIdString);
  const scanResult: ScanResult = req.body;

  const where = { modelVersionId_type: { modelVersionId, type } };
  const { url } = (await prisma.modelFile.findUnique({ where })) ?? {};
  if (!url) return res.status(404).json({ error: 'File not found' });

  const { hasDanger, pickleScanMessage } = examinePickleScanMessage(scanResult);
  if (hasDanger) scanResult.picklescanExitCode = ScanExitCode.Danger;

  const exists = scanResult.fileExists === 1;

  const data: Prisma.ModelFileUpdateInput = {
    exists,
    scannedAt: new Date(),
    rawScanResult: scanResult,
    virusScanResult: resultCodeMap[scanResult.clamscanExitCode],
    virusScanMessage:
      scanResult.clamscanExitCode != ScanExitCode.Success ? scanResult.clamscanOutput : null,
    pickleScanResult: resultCodeMap[scanResult.picklescanExitCode],
    pickleScanMessage,
  };

  const bucket = env.S3_UPLOAD_BUCKET;
  const scannerImportedFile = !url.includes(bucket) && scanResult.url.includes(bucket);
  if (exists && scannerImportedFile) data.url = scanResult.url;

  await prisma.modelFile.update({ where, data });

  if (!exists) {
    await prisma.modelVersion.update({
      where: { id: modelVersionId },
      data: { status: ModelStatus.Draft },
    });

    const { modelId } =
      (await prisma.modelVersion.findUnique({
        where: { id: modelVersionId },
        select: { modelId: true },
      })) ?? {};
    if (modelId) {
      const modelVersionCount = await prisma.model.findUnique({
        where: { id: modelId },
        select: {
          _count: {
            select: {
              modelVersions: {
                where: { status: ModelStatus.Published },
              },
            },
          },
        },
      });

      if (modelVersionCount?._count.modelVersions === 0)
        await prisma.model.update({
          where: { id: modelId },
          data: { status: ModelStatus.Unpublished },
        });
    }
  }

  res.status(200).json({ ok: true });
});

enum ScanExitCode {
  Pending = -1,
  Success = 0,
  Danger = 1,
  Error = 2,
}

const resultCodeMap = {
  [ScanExitCode.Pending]: ScanResultCode.Pending,
  [ScanExitCode.Success]: ScanResultCode.Success,
  [ScanExitCode.Danger]: ScanResultCode.Danger,
  [ScanExitCode.Error]: ScanResultCode.Error,
};

type ScanResult = {
  url: string;
  fileExists: number;
  picklescanExitCode: ScanExitCode;
  picklescanOutput?: string;
  picklescanGlobalImports?: string[];
  picklescanDangerousImports?: string[];
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
  picklescanExitCode,
  picklescanDangerousImports,
  picklescanGlobalImports,
}: ScanResult) {
  if (picklescanExitCode === ScanExitCode.Pending) return {};
  picklescanDangerousImports ??= [];
  picklescanGlobalImports ??= [];

  const importCount =
    (picklescanDangerousImports?.length ?? 0) + (picklescanGlobalImports?.length ?? 0);
  if (importCount === 0 || (!picklescanDangerousImports && !picklescanGlobalImports))
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
