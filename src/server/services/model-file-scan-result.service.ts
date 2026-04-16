import type { WorkflowEvent } from '@civitai/client';
import { getWorkflow } from '@civitai/client';
import type { NextApiRequest } from 'next';
import { dbWrite } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { ModelHashType, ScanResultCode } from '~/shared/utils/prisma/enums';

// Step output types matching @civitai/client definitions
type ModelClamScanStep = {
  $type: 'modelClamScan';
  output?: { exitCode?: number | null; output?: string | null };
};

type ModelPickleScanStep = {
  $type: 'modelPickleScan';
  output?: {
    exitCode?: number | null;
    output?: string | null;
    globalImports?: string[] | null;
    dangerousImports?: string[] | null;
  };
};

type ModelHashStep = {
  $type: 'modelHash';
  output?: {
    shA256?: string | null;
    autoV1?: string | null;
    autoV2?: string | null;
    autoV3?: string | null;
    blake3?: string | null;
    crC32?: string | null;
  };
};

type ModelParseMetadataStep = {
  $type: 'modelParseMetadata';
  output?: { metadata?: string | null };
};

type ModelScanStep =
  | ModelClamScanStep
  | ModelPickleScanStep
  | ModelHashStep
  | ModelParseMetadataStep;

const exitCodeToScanResult = (exitCode: number | null | undefined): ScanResultCode => {
  switch (exitCode) {
    case 0:
      return ScanResultCode.Success;
    case 1:
      return ScanResultCode.Danger;
    case 2:
      return ScanResultCode.Error;
    default:
      return ScanResultCode.Pending;
  }
};

const hashFieldMap: Record<string, ModelHashType> = {
  shA256: ModelHashType.SHA256,
  autoV1: ModelHashType.AutoV1,
  autoV2: ModelHashType.AutoV2,
  autoV3: ModelHashType.AutoV3,
  blake3: ModelHashType.BLAKE3,
  crC32: ModelHashType.CRC32,
};

const specialImports: string[] = ['pytorch_lightning.callbacks.model_checkpoint.ModelCheckpoint'];

function processImport(importStr: string) {
  importStr = decodeURIComponent(importStr);
  const importParts = importStr.split(',').map((x) => x.replace(/'/g, '').trim());
  return importParts.join('.');
}

function examinePickleImports({
  exitCode,
  dangerousImports,
  globalImports,
}: {
  exitCode?: number | null;
  dangerousImports?: string[] | null;
  globalImports?: string[] | null;
}) {
  if (exitCode == null || exitCode === -1) return {};

  dangerousImports ??= [];
  globalImports ??= [];

  const importCount = dangerousImports.length + globalImports.length;
  if (importCount === 0) return { pickleScanMessage: 'No Pickle imports', hasDanger: false };

  // Check for special imports that should be flagged as dangerous
  const dangerousGlobals = globalImports.filter((x) => specialImports.includes(processImport(x)));
  for (const imp of dangerousGlobals) {
    dangerousImports.push(imp);
    globalImports.splice(globalImports.indexOf(imp), 1);
  }

  const lines: string[] = [`**Detected Pickle imports (${importCount})**`];
  const hasDanger = dangerousImports.length > 0;
  if (hasDanger) lines.push('*Dangerous import detected*');

  lines.push('```');
  for (const imp of dangerousImports) lines.push(`*${processImport(imp)}*`);
  for (const imp of globalImports) lines.push(processImport(imp));
  lines.push('```');

  return { pickleScanMessage: lines.join('\n'), hasDanger };
}

export async function processModelFileScanResult(req: NextApiRequest) {
  const event: WorkflowEvent = req.body;

  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId: event.workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${event.workflowId}`);

  const fileId = data.metadata?.fileId as number | undefined;
  if (!fileId) throw new Error(`missing workflow metadata.fileId - ${event.workflowId}`);

  const modelVersionId = data.metadata?.modelVersionId as number | undefined;

  if (event.status !== 'succeeded') {
    logToAxiom(
      {
        type: 'warning',
        name: 'model-file-scan-result',
        message: `Workflow ${event.status} for file ${fileId}`,
        workflowId: event.workflowId,
        fileId,
        status: event.status,
      },
      'webhooks'
    ).catch();
    return;
  }

  const steps = (data.steps ?? []) as unknown as ModelScanStep[];

  const clamScan = steps.find((x) => x.$type === 'modelClamScan') as ModelClamScanStep | undefined;
  const pickleScan = steps.find((x) => x.$type === 'modelPickleScan') as
    | ModelPickleScanStep
    | undefined;
  const hashStep = steps.find((x) => x.$type === 'modelHash') as ModelHashStep | undefined;
  const parseMetadata = steps.find((x) => x.$type === 'modelParseMetadata') as
    | ModelParseMetadataStep
    | undefined;

  // Build file update
  const data_: Parameters<typeof dbWrite.modelFile.update>[0]['data'] = {
    scannedAt: new Date(),
  };

  // ClamAV scan
  if (clamScan?.output) {
    data_.virusScanResult = exitCodeToScanResult(clamScan.output.exitCode);
    data_.virusScanMessage = clamScan.output.exitCode !== 0 ? clamScan.output.output ?? null : null;
  }

  // Pickle scan
  if (pickleScan?.output) {
    data_.pickleScanResult = exitCodeToScanResult(pickleScan.output.exitCode);
    const { pickleScanMessage, hasDanger } = examinePickleImports({
      exitCode: pickleScan.output.exitCode,
      dangerousImports: pickleScan.output.dangerousImports,
      globalImports: pickleScan.output.globalImports,
    });
    data_.pickleScanMessage = pickleScanMessage ?? null;
    if (hasDanger) data_.pickleScanResult = ScanResultCode.Danger;
  }

  // Parse metadata
  if (parseMetadata?.output?.metadata) {
    try {
      let headerData = JSON.parse(parseMetadata.output.metadata);
      if (typeof headerData?.ss_tag_frequency === 'string') {
        headerData.ss_tag_frequency = JSON.parse(headerData.ss_tag_frequency);
      }
      data_.headerData = headerData;
    } catch {
      // metadata wasn't valid JSON, skip
    }
  }

  // Update file record
  await dbWrite.modelFile.update({
    where: { id: fileId },
    data: data_,
  });

  // Upsert hashes
  if (hashStep?.output) {
    const hashes = Object.entries(hashStep.output)
      .filter(([field, val]) => hashFieldMap[field] && val)
      .map(([field, hash]) => ({
        fileId,
        type: hashFieldMap[field],
        hash: hash as string,
      }));

    if (hashes.length > 0) {
      await dbWrite.$transaction([
        dbWrite.modelFileHash.deleteMany({ where: { fileId } }),
        dbWrite.modelFileHash.createMany({ data: hashes }),
      ]);
    }
  }

  // Update search index and bust caches
  const resolvedModelVersionId =
    modelVersionId ??
    (
      await dbWrite.modelFile.findUnique({
        where: { id: fileId },
        select: { modelVersionId: true },
      })
    )?.modelVersionId;

  if (resolvedModelVersionId) {
    await deleteFilesForModelVersionCache(resolvedModelVersionId);

    const version = await dbWrite.modelVersion.findUnique({
      where: { id: resolvedModelVersionId },
      select: { modelId: true },
    });
    if (version?.modelId) {
      await modelsSearchIndex.queueUpdate([
        { id: version.modelId, action: SearchIndexUpdateQueueAction.Update },
      ]);
      await dataForModelsCache.bust(version.modelId);
    }
  }

  logToAxiom(
    {
      type: 'info',
      name: 'model-file-scan-result',
      message: `Completed scan result processing for file ${fileId}`,
      fileId,
      workflowId: event.workflowId,
    },
    'webhooks'
  ).catch();
}
