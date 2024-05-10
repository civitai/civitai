import { ModelHashType, ModelStatus, Prisma, ScanResultCode } from '@prisma/client';
import { z } from 'zod';

import { env } from '~/env/server.mjs';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { ScannerTasks } from '~/server/jobs/scan-files';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileId, ...query } = querySchema.parse(req.query);
  const tasks = query.tasks ?? ['Import', 'Scan', 'Hash', 'ParseMetadata'];
  const scanResult: ScanResult = req.body;

  const where: Prisma.ModelFileFindUniqueArgs['where'] = { id: fileId };
  const file = await dbRead.modelFile.findUnique({ where });
  if (!file) return res.status(404).json({ error: 'File not found' });

  const data: Prisma.ModelFileUpdateInput = {};

  // Update scan result
  if (tasks.includes('Scan')) {
    data.scannedAt = new Date();
    data.rawScanResult = scanResult;
    data.virusScanResult = resultCodeMap[scanResult.clamscanExitCode];
    data.virusScanMessage =
      scanResult.clamscanExitCode != ScanExitCode.Success ? scanResult.clamscanOutput : null;
    data.pickleScanResult = resultCodeMap[scanResult.picklescanExitCode];

    const { hasDanger, pickleScanMessage } = examinePickleScanMessage(scanResult);
    data.pickleScanMessage = pickleScanMessage;
    if (hasDanger) scanResult.picklescanExitCode = ScanExitCode.Danger;
  }

  if (tasks.includes('ParseMetadata')) {
    data.headerData = scanResult.metadata;
  }

  // Update url if we imported/moved the file
  if (tasks.includes('Import')) {
    data.exists = scanResult.fileExists === 1;
    const bucket = env.S3_UPLOAD_BUCKET;
    const scannerImportedFile = !file.url.includes(bucket) && scanResult.url.includes(bucket);
    if (data.exists && scannerImportedFile) data.url = scanResult.url;
    if (!data.exists) await unpublish(file.modelVersionId);
  }

  if (tasks.includes('Convert')) {
    // TODO justin: handle conversion result
    // TODO koen: include the new size in the conversionOutput
    // const [format, { url, hashes, conversionOutput }] = Object.entries(scanResult.conversions)[0];
    // const baseUrl = url.split('?')[0];
    // const convertedName = baseUrl.split('/').pop();
    // if (convertedName) {
    //   await dbWrite.modelFile.create({
    //     data: {
    //       name: convertedName,
    //       sizeKB,
    //       modelVersionId: file.modelVersionId,
    //       url: baseUrl,
    //       type: file.type,
    //       metadata: { format: format === 'safetensors' ? 'SafeTensor' : 'PickleTensor' },
    //       hashes: {
    //         create: Object.entries(hashes).map(([type, hash]) => ({
    //           type: hashTypeMap[type.toLowerCase()] as ModelHashType,
    //           hash,
    //         })),
    //       },
    //     },
    //   });
    // }
  }

  // Update if we made changes...
  if (Object.keys(data).length > 0) await dbWrite.modelFile.update({ where, data });

  // Update hashes
  if (tasks.includes('Hash') && scanResult.hashes) {
    await dbWrite.$transaction([
      dbWrite.modelFileHash.deleteMany({ where: { fileId } }),
      dbWrite.modelFileHash.createMany({
        data: Object.entries(scanResult.hashes)
          .filter(([type, val]) => hashTypeMap[type.toLowerCase()] && val)
          .map(([type, hash]) => ({
            fileId,
            type: hashTypeMap[type.toLowerCase()] as ModelHashType,
            hash,
          })),
      }),
    ]);

    // Update search index
    const version = await dbRead.modelVersion.findUnique({
      where: { id: file.modelVersionId },
      select: { modelId: true },
    });
    if (version?.modelId)
      await modelsSearchIndex.queueUpdate([
        {
          id: version.modelId,
          action: SearchIndexUpdateQueueAction.Update,
        },
      ]);
  }

  res.status(200).json({ ok: true });
});

const hashTypeMap: Record<string, string> = {};
for (const t of Object.keys(ModelHashType)) hashTypeMap[t.toLowerCase()] = t;

async function unpublish(modelVersionId: number) {
  await dbWrite.modelVersion.update({
    where: { id: modelVersionId },
    data: { status: ModelStatus.Draft, publishedAt: null },
  });

  const { modelId } =
    (await dbWrite.modelVersion.findUnique({
      where: { id: modelVersionId },
      select: { modelId: true },
    })) ?? {};
  if (modelId) {
    const modelVersionCount = await dbWrite.model.findUnique({
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
      await dbWrite.model.update({
        where: { id: modelId },
        data: { status: ModelStatus.Unpublished, publishedAt: null },
      });
  }
}

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
  hashes: Record<ModelHashType, string>;
  metadata: MixedObject;
  conversions: Record<'safetensors' | 'ckpt', ConversionResult>;
};

type ConversionResult = {
  url: string;
  hashes: Record<ModelHashType, string>;
  conversionOutput: string;
};

const querySchema = z.object({
  fileId: z.preprocess((val) => Number(val), z.number()),
  tasks: z
    .preprocess((val) => (Array.isArray(val) ? val : [val]), z.array(z.enum(ScannerTasks)))
    .optional(),
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
