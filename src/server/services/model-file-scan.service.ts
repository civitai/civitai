import type { Prisma } from '@prisma/client';
import type { WorkflowEvent } from '@civitai/client';
import { getWorkflow } from '@civitai/client';
import type { NextApiRequest } from 'next';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { requestScannerTasks } from '~/server/jobs/scan-files';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';
import { unpublishModelById } from '~/server/services/model.service';
import { createNotification } from '~/server/services/notification.service';
import { createModelFileScanRequest } from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { ModelHashType, ScanResultCode } from '~/shared/utils/prisma/enums';

// -----------------------------------------------------------------------------
// Shared scan outcome — the normalized shape that both webhook adapters produce
// and that applyScanOutcome() consumes. Adding fields here is the right way to
// preserve behavior across the legacy/orchestrator paths during rollout.
// -----------------------------------------------------------------------------

export type ScanOutcome = {
  fileId: number;
  modelVersionId?: number;
  /** When true, the upstream workflow/scan failed and the file should be retried. */
  failed?: boolean;
  virusScan?: { result: ScanResultCode; message: string | null };
  pickleScan?: {
    result: ScanResultCode;
    message: string | null;
    /** Used for hash-blocking parity once re-enabled. */
    dangerousImports?: string[];
  };
  /** Map of ModelHashType -> hex digest. Only present when hashes were computed. */
  hashes?: Partial<Record<ModelHashType, string>>;
  /** Parsed safetensors header. May be unset if the file isn't safetensors. */
  headerData?: unknown;
  /** Full upstream payload (orchestrator step outputs or legacy ScanResult) for forensics. */
  rawScanResult?: unknown;
};

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

const specialImports: string[] = ['pytorch_lightning.callbacks.model_checkpoint.ModelCheckpoint'];

function processImport(importStr: string) {
  importStr = decodeURIComponent(importStr);
  const importParts = importStr.split(',').map((x) => x.replace(/'/g, '').trim());
  return importParts.join('.');
}

export function examinePickleImports({
  exitCode,
  dangerousImports,
  globalImports,
}: {
  exitCode?: number | null;
  dangerousImports?: string[] | null;
  globalImports?: string[] | null;
}) {
  if (exitCode == null || exitCode === -1) return { pickleScanMessage: null, hasDanger: false };

  // Shallow-copy so the splice/push below don't mutate caller's arrays. The
  // raw payload reference is later serialized into rawScanResult for forensics
  // and we don't want the stored shape to differ from what the scanner sent.
  const dangerous: string[] = [...(dangerousImports ?? [])];
  const globals: string[] = [...(globalImports ?? [])];

  const importCount = dangerous.length + globals.length;
  if (importCount === 0) return { pickleScanMessage: 'No Pickle imports', hasDanger: false };

  // Promote special globals to dangerous.
  const dangerousGlobals = globals.filter((x) => specialImports.includes(processImport(x)));
  for (const imp of dangerousGlobals) {
    dangerous.push(imp);
    globals.splice(globals.indexOf(imp), 1);
  }

  const lines: string[] = [`**Detected Pickle imports (${importCount})**`];
  const hasDanger = dangerous.length > 0;
  if (hasDanger) lines.push('*Dangerous import detected*');

  lines.push('```');
  for (const imp of dangerous) lines.push(`*${processImport(imp)}*`);
  for (const imp of globals) lines.push(processImport(imp));
  lines.push('```');

  return { pickleScanMessage: lines.join('\n'), hasDanger };
}

// -----------------------------------------------------------------------------
// applyScanOutcome — the single source of truth for "scan finished, update DB".
// Both /api/webhooks/scan-result (legacy) and /api/webhooks/model-file-scan-result
// (orchestrator) call this after normalizing their payload into a ScanOutcome.
// Keeping all DB writes here guarantees zero behavioral drift between paths.
// -----------------------------------------------------------------------------

export async function applyScanOutcome(outcome: ScanOutcome): Promise<void> {
  const { fileId } = outcome;

  const file = await dbWrite.modelFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      modelVersionId: true,
      modelVersion: { select: { modelId: true } },
    },
  });
  if (!file) {
    logToAxiom(
      { type: 'warning', name: 'apply-scan-outcome', message: `File not found: ${fileId}`, fileId },
      'webhooks'
    ).catch();
    return;
  }

  // D4: failed workflow — bump scanRequestedAt to now so the file qualifies for
  // the fallback job's 24h-stale retry path, NOT the immediate-retry path. This
  // gives natural backoff (24h) for permanently-broken AIRs and avoids tight
  // loops if the orchestrator keeps rejecting the same file. Transient outages
  // are accepted as a 24h delay; we don't have a retry-counter column.
  if (outcome.failed) {
    await dbWrite.modelFile.update({
      where: { id: fileId },
      data: { scanRequestedAt: new Date() },
    });
    return;
  }

  // Capture pre-existing AutoV2 BEFORE any hash deletion. Used for hash-fix
  // notification (D3). SHA256 capture goes here too if we ever re-enable D2.
  const existingHashes = outcome.hashes
    ? await dbWrite.modelFileHash.findMany({
        where: { fileId, type: { in: [ModelHashType.SHA256, ModelHashType.AutoV2] } },
        select: { type: true, hash: true },
      })
    : [];
  const existingAutoV2 = existingHashes.find((h) => h.type === ModelHashType.AutoV2)?.hash;

  // Build the file-level update. scannedAt only advances when a scan actually
  // ran — legacy callers that request just `Hash`/`ParseMetadata` (e.g.
  // clean-up.ts) shouldn't appear "scanned" without virus/pickle results.
  const data: Prisma.ModelFileUpdateInput = {};
  const ranScan = Boolean(outcome.virusScan || outcome.pickleScan);
  if (ranScan) data.scannedAt = new Date();

  if (outcome.virusScan) {
    data.virusScanResult = outcome.virusScan.result;
    data.virusScanMessage = outcome.virusScan.message;
  }

  if (outcome.pickleScan) {
    data.pickleScanResult = outcome.pickleScan.result;
    data.pickleScanMessage = outcome.pickleScan.message;
  }

  if (outcome.headerData !== undefined) {
    data.headerData = outcome.headerData as Prisma.InputJsonValue;
  }

  if (outcome.rawScanResult !== undefined) {
    data.rawScanResult = outcome.rawScanResult as Prisma.InputJsonValue;
  }

  await dbWrite.modelFile.update({ where: { id: fileId }, data });

  // Hash upsert (delete + createMany) — same pattern as legacy.
  if (outcome.hashes) {
    const hashRows = (Object.entries(outcome.hashes) as Array<[ModelHashType, string]>)
      .filter(([, hash]) => Boolean(hash))
      .map(([type, hash]) => ({ fileId, type, hash }));

    if (hashRows.length > 0) {
      await dbWrite.$transaction([
        dbWrite.modelFileHash.deleteMany({ where: { fileId } }),
        dbWrite.modelFileHash.createMany({ data: hashRows }),
      ]);
    }

    // D2: hash-blocking is intentionally disabled here, matching legacy
    // scan-result.ts:126-128 which is also commented out. Re-enable as a
    // separate decision; will need pre-existing SHA256 capture above.
    // const newSha256 = outcome.hashes.SHA256;
    // const existingSha256 = existingHashes.find((h) => h.type === ModelHashType.SHA256)?.hash;
    // const hashChanged = !existingSha256 || existingSha256 !== newSha256;
    // if (newSha256 && hashChanged && (await isModelHashBlocked(newSha256))) {
    //   await unpublishBlockedModel(file.modelVersionId);
    // }
  }

  // D3: model-hash-fix notification. Legacy fired this when the scanner reported
  // `fixed: ['sshs_hash']`. The orchestrator doesn't expose that signal, so we
  // synthesize from a change in AutoV2 (which is what scanners "fix").
  const newAutoV2 = outcome.hashes?.AutoV2;
  if (newAutoV2 && existingAutoV2 && existingAutoV2 !== newAutoV2) {
    await notifyHashFix(file.modelVersionId, fileId).catch((err) => {
      logToAxiom(
        {
          type: 'error',
          name: 'apply-scan-outcome',
          message: 'hash-fix notification failed',
          fileId,
          error: err instanceof Error ? err.message : String(err),
        },
        'webhooks'
      ).catch();
    });
  }

  // Search index + cache invalidation. modelId comes from the initial lookup so
  // there's no second round-trip per webhook callback.
  const modelVersionId = outcome.modelVersionId ?? file.modelVersionId;
  await deleteFilesForModelVersionCache(modelVersionId);

  const modelId = file.modelVersion?.modelId;
  if (modelId) {
    await modelsSearchIndex.queueUpdate([
      { id: modelId, action: SearchIndexUpdateQueueAction.Update },
    ]);
    // D5: refresh (proactive re-warm) matches legacy behavior.
    await dataForModelsCache.refresh(modelId);
  }
}

async function notifyHashFix(modelVersionId: number, fileId: number) {
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      id: true,
      name: true,
      model: { select: { id: true, name: true, userId: true } },
    },
  });
  if (!version?.model?.userId) return;

  await createNotification({
    category: NotificationCategory.System,
    type: 'model-hash-fix',
    key: `model-hash-fix:${version.model.id}:${fileId}`,
    details: {
      modelId: version.model.id,
      versionId: version.id,
      modelName: version.model.name,
      versionName: version.name,
    },
    userId: version.model.userId,
  });
}

// -----------------------------------------------------------------------------
// Orchestrator-specific adapter — fetches the workflow, normalizes step outputs
// into a ScanOutcome, and delegates to applyScanOutcome().
// -----------------------------------------------------------------------------

type ModelClamScanStep = {
  $type: 'modelClamScan';
  output?: {
    exitCode?: number | null;
    output?: string | null;
    /** Orchestrator status enum, e.g. "clean" | "infected" | "error" | etc. */
    status?: string | null;
    infected?: boolean | null;
    infectedFileCount?: number | null;
    scannedFileCount?: number | null;
  };
};

type ModelPickleScanStep = {
  $type: 'modelPickleScan';
  output?: {
    exitCode?: number | null;
    output?: string | null;
    globalImports?: string[] | null;
    dangerousImports?: string[] | null;
    /** Orchestrator status enum, e.g. "clean" | "dangerous" | "skippedSafetensors" | etc. */
    status?: string | null;
    dangerousImportsFound?: boolean | null;
    skipped?: boolean | null;
    skipReason?: string | null;
    scannedFileCount?: number | null;
    infectedFileCount?: number | null;
    dangerousGlobalCount?: number | null;
  };
};

type ModelHashStep = {
  $type: 'modelHash';
  output?: {
    sha256?: string | null;
    autoV1?: string | null;
    autoV2?: string | null;
    autoV3?: string | null;
    blake3?: string | null;
    crc32?: string | null;
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

const orchestratorHashFieldMap: Record<string, ModelHashType> = {
  sha256: ModelHashType.SHA256,
  autoV1: ModelHashType.AutoV1,
  autoV2: ModelHashType.AutoV2,
  autoV3: ModelHashType.AutoV3,
  blake3: ModelHashType.BLAKE3,
  crc32: ModelHashType.CRC32,
};

// Orchestrator now reports scan outcomes via a `status` enum (and explicit
// boolean flags) instead of POSIX exit codes. Map the known status strings,
// fall through to the legacy exitCode path to remain compatible with any
// in-flight workflows that pre-date the orchestrator update.
function deriveClamScanResult(output: NonNullable<ModelClamScanStep['output']>): ScanResultCode {
  if (output.infected === true) return ScanResultCode.Danger;
  const status = output.status?.toLowerCase();
  if (status) {
    if (status === 'clean') return ScanResultCode.Success;
    if (status.includes('infect') || status.includes('danger')) return ScanResultCode.Danger;
    if (status.includes('error') || status.includes('fail')) return ScanResultCode.Error;
    return ScanResultCode.Pending;
  }
  return exitCodeToScanResult(output.exitCode);
}

function derivePickleScanResult(
  output: NonNullable<ModelPickleScanStep['output']>
): ScanResultCode {
  if (output.dangerousImportsFound === true) return ScanResultCode.Danger;
  if (output.skipped === true) return ScanResultCode.Success;
  const status = output.status?.toLowerCase();
  if (status) {
    if (status === 'clean' || status.startsWith('skipped')) return ScanResultCode.Success;
    if (status.includes('danger') || status.includes('infect')) return ScanResultCode.Danger;
    if (status.includes('error') || status.includes('fail')) return ScanResultCode.Error;
    return ScanResultCode.Pending;
  }
  return exitCodeToScanResult(output.exitCode);
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
    await applyScanOutcome({ fileId, modelVersionId, failed: true });
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

  const outcome: ScanOutcome = {
    fileId,
    modelVersionId,
    rawScanResult: { source: 'orchestrator', workflowId: event.workflowId, steps },
  };

  if (clamScan?.output) {
    const result = deriveClamScanResult(clamScan.output);
    outcome.virusScan = {
      result,
      message: result !== ScanResultCode.Success ? clamScan.output.output ?? null : null,
    };
  }

  if (pickleScan?.output) {
    const pickleOut = pickleScan.output;
    // Skipped (e.g. safetensors) means picklescan never inspected imports —
    // don't synthesize a "No Pickle imports" message; the Success result code
    // is the source of truth.
    const { pickleScanMessage, hasDanger: importsDanger } = pickleOut.skipped
      ? { pickleScanMessage: null, hasDanger: false }
      : examinePickleImports({
          // exitCode is no longer reported by the orchestrator; pass 0 to opt
          // examinePickleImports out of its null/-1 short-circuit and let it
          // build the imports list as it always has.
          exitCode: 0,
          dangerousImports: pickleOut.dangerousImports,
          globalImports: pickleOut.globalImports,
        });

    const baseResult = derivePickleScanResult(pickleOut);
    const hasDanger = pickleOut.dangerousImportsFound === true || importsDanger;
    outcome.pickleScan = {
      result: hasDanger ? ScanResultCode.Danger : baseResult,
      message: pickleScanMessage,
      dangerousImports: pickleOut.dangerousImports ?? undefined,
    };
  }

  if (hashStep?.output) {
    const hashes: Partial<Record<ModelHashType, string>> = {};
    for (const [key, value] of Object.entries(hashStep.output)) {
      const type = orchestratorHashFieldMap[key];
      if (type && typeof value === 'string' && value) hashes[type] = value;
    }
    if (Object.keys(hashes).length > 0) outcome.hashes = hashes;
  }

  if (parseMetadata?.output?.metadata) {
    try {
      const headerData = JSON.parse(parseMetadata.output.metadata);
      if (typeof headerData?.ss_tag_frequency === 'string') {
        try {
          headerData.ss_tag_frequency = JSON.parse(headerData.ss_tag_frequency);
        } catch {
          // leave as string if inner parse fails
        }
      }
      outcome.headerData = headerData;
    } catch {
      // metadata wasn't valid JSON, skip
    }
  }

  await applyScanOutcome(outcome);

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

// -----------------------------------------------------------------------------
// rescanModel — admin/moderator-driven re-scan dispatch. Flag-branched between
// the legacy scanner and the orchestrator path so a wrong branch can't silently
// route to the wrong system.
// -----------------------------------------------------------------------------

export const rescanModel = async ({ id }: GetByIdInput) => {
  const useOrchestrator = await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_FILE_SCAN_ORCHESTRATOR);

  const modelFiles = await dbRead.modelFile.findMany({
    where: { modelVersion: { modelId: id } },
    select: useOrchestrator
      ? {
          id: true,
          url: true,
          modelVersion: {
            select: {
              id: true,
              baseModel: true,
              model: { select: { id: true, type: true } },
            },
          },
        }
      : { id: true, url: true },
  });

  if (modelFiles.length === 0) return { sent: 0, failed: 0 };

  const sent: number[] = [];
  const failed: number[] = [];

  const tasks = modelFiles.map((file) => async () => {
    if (useOrchestrator) {
      const f = file as (typeof modelFiles)[number] & {
        modelVersion: {
          id: number;
          baseModel: string;
          model: { id: number; type: ModelType };
        } | null;
      };
      // Soft-deleted version → orphaned file. Skip rather than crash on the
      // null dereference that the conditional-select cast hides.
      if (!f.modelVersion) {
        failed.push(f.id);
        return;
      }
      try {
        await createModelFileScanRequest({
          fileId: f.id,
          modelVersionId: f.modelVersion.id,
          modelId: f.modelVersion.model.id,
          modelType: f.modelVersion.model.type,
          baseModel: f.modelVersion.baseModel,
          priority: 'low',
        });
        sent.push(f.id);
      } catch {
        failed.push(f.id);
      }
      return;
    }

    const result = await requestScannerTasks({
      file,
      tasks: ['Hash', 'Scan', 'ParseMetadata'],
      lowPriority: true,
    });
    if (result === 'sent') sent.push(file.id);
    else failed.push(file.id);
  });

  await limitConcurrency(tasks, 10);

  if (sent.length > 0) {
    await dbWrite.modelFile.updateMany({
      where: { id: { in: sent } },
      data: { scanRequestedAt: new Date() },
    });
  }

  return { sent: sent.length, failed: failed.length };
};

// -----------------------------------------------------------------------------
// unpublishBlockedModel — invoked when a file's hash matches a blocked entry.
// Lives here (vs. model.service.ts) so the orchestrator-side scan flow and the
// retroactive-hash-blocking job can both import it from a stable location.
// -----------------------------------------------------------------------------

export async function unpublishBlockedModel(modelVersionId: number) {
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: { id: true, model: { select: { id: true, meta: true } } },
  });
  if (!version?.model?.id) return;

  const meta = (version.model.meta as ModelMeta | null) || {};
  await unpublishModelById({
    id: version.model.id,
    reason: 'duplicate',
    meta,
    customMessage: 'Model has been unpublished due to matching a blocked hash',
    userId: -1,
    isModerator: true,
  });
}
