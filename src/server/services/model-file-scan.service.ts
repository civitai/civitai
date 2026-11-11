import type { Prisma } from '@prisma/client';
import type { WorkflowEvent } from '@civitai/orchestration-client';
import { getWorkflow } from '@civitai/orchestration-client';
import type { NextApiRequest } from 'next';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { modelsSearchIndex } from '~/server/search-index';
import {
  deleteFilesForModelVersionCache,
  findOfficialFileByHash,
} from '~/server/services/model-file.service';
import { unpublishModelById } from '~/server/services/model.service';
import { checkMinorHashOnScan, MINOR_HASH_FILE_TYPE } from '~/server/services/minor-hash.service';
import { checkPoiHashOnScan } from '~/server/services/poi-hash.service';
import { checkDuplicateHashOnScan } from '~/server/services/duplicate-model-hash.service';
import { createNotification } from '~/server/services/notification.service';
import { LOADABLE_FILE_TYPES } from '~/server/services/resource-residency.service';
import {
  bustOrchestratorModelCache,
  bustOrchestratorScannedFileCache,
} from '~/server/services/orchestrator/models';
import {
  createModelFileScanRequest,
  ModelFileScanSubmissionError,
} from '~/server/services/orchestrator/orchestrator.service';
import { SCAN_ONLY_RESCAN_OP } from '~/server/services/orchestrator/model-scan-ops';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { constants } from '~/server/common/constants';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { ModelHashType, ModelStatus, ScanResultCode } from '~/shared/utils/prisma/enums';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import type { ModelFileType } from '~/server/common/constants';
import {
  addLinkedComponent,
  unpublishModelVersionById,
} from '~/server/services/model-version.service';
import { excludedFromCoverage, hasFailedScan } from '~/server/utils/failed-scan';
import { bustVersionScannedFileAirs } from '~/server/services/orchestrator/scanned-file-airs';
import { Tracker } from '~/server/clickhouse/client';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';
import { clamFilesScanned } from '~/server/services/orchestrator/consumer-blob-scan';
import { PUBLIC_MODEL_STATUSES } from '~/server/services/text-scan/public-content';
import {
  submitTrainingDataScanSafe,
  TRAINING_DATA_BLOB_SCAN,
  HEAL_OP,
  trainingDataObjectUnchanged,
  uncountUnconfirmedResubmit,
} from '~/server/services/training-data-scan.service';

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
    /** The scanner read no pickle. Clears a file no loader opens; a zip is judged by the scan of
     *  its contents. */
    unread?: 'unknown-format' | 'nothing-read';
  };
  /** Map of ModelHashType -> hex digest. Only present when hashes were computed. */
  hashes?: Partial<Record<ModelHashType, string>>;
  /** Parsed safetensors header. May be unset if the file isn't safetensors. */
  headerData?: unknown;
  /** Full upstream payload (orchestrator step outputs or legacy ScanResult) for forensics. */
  rawScanResult?: unknown;
  /** The stored url a Training Data blob scan copied. Only an outcome naming the file's current url
   *  may write a Training Data file. */
  trainingDataUrl?: string;
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

// Postgres rejects U+0000 in both text and jsonb (22P05), and safetensors headers can carry it,
// so one NUL in a trainer's metadata would fail the whole update and leave the file Pending.
function stripNul<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\u0000/g, '') as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replace(/\u0000/g, ''), stripNul(v)])
    ) as T;
  }
  return value;
}

export async function applyScanOutcome(outcome: ScanOutcome): Promise<void> {
  const { fileId } = outcome;

  const file = await dbWrite.modelFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      name: true,
      type: true,
      url: true,
      modelVersionId: true,
      // SSHS_12 comes from the metadata-parse step, but the hash rebuild below deletes every row
      // for the file — so a hash-only rescan has to re-derive it from what is already stored.
      headerData: true,
      sizeKB: true,
      pickleScanResult: true,
      virusScanResult: true,
      modelVersion: {
        select: {
          modelId: true,
          baseModel: true,
          model: { select: { userId: true, status: true, meta: true, type: true } },
        },
      },
    },
  });
  if (!file) {
    logToAxiom(
      {
        type: 'warning',
        name: 'apply-scan-outcome',
        message: `File not found: ${fileId}`,
        fileId,
        modelVersionId: outcome.modelVersionId,
      },
      'webhooks'
    ).catch();
    return;
  }

  // A Training Data verdict counts only from its own blob scan of the file's current url: a late
  // result from another scan, from before the file's zip was swapped, or for a file relabelled since
  // (which needs the model-file scan instead) is dropped.
  const isTrainingData = file.type === 'Training Data';
  const isBlobScan = outcome.trainingDataUrl !== undefined;
  if ((isTrainingData || isBlobScan) && (!isTrainingData || outcome.trainingDataUrl !== file.url)) {
    logToAxiom(
      {
        type: 'warning',
        name: 'apply-scan-outcome',
        message: `Dropped a stale training data scan result for file ${fileId}`,
        fileId,
        modelVersionId: outcome.modelVersionId,
      },
      'webhooks'
    ).catch();
    return;
  }

  // A Danger on a dataset stands: a later clean result, perhaps from an older scan, never replaces it.
  if (
    isTrainingData &&
    file.virusScanResult === ScanResultCode.Danger &&
    outcome.virusScan &&
    outcome.virusScan.result !== ScanResultCode.Danger
  ) {
    logToAxiom(
      {
        type: 'warning',
        name: 'apply-scan-outcome',
        message: `Kept the Danger verdict of training data file ${fileId}`,
        fileId,
      },
      'webhooks'
    ).catch();
    return;
  }

  // A Training Data write names the url checked above, so a zip swapped in meanwhile is untouched.
  const sameBytes = file.type === 'Training Data' ? { url: file.url, type: 'Training Data' } : {};

  // D4: failed workflow — bump scanRequestedAt to now so the file qualifies for
  // the fallback job's 24h-stale retry path, NOT the immediate-retry path. This
  // gives natural backoff (24h) for permanently-broken AIRs and avoids tight
  // loops if the orchestrator keeps rejecting the same file. Transient outages
  // are accepted as a 24h delay; we don't have a retry-counter column.
  // Training Data is not on that path: the fallback job skips it, and the self-heal
  // resubmits it once this stamp is an hour old.
  if (outcome.failed) {
    await dbWrite.modelFile.update({
      where: { id: fileId, ...sameBytes },
      data: { scanRequestedAt: new Date() },
    });
    await bustAfterFailedScan(outcome.modelVersionId ?? file.modelVersionId, file);
    return;
  }

  // Capture pre-existing hashes BEFORE any hash deletion: AutoV2 for the hash-fix
  // notification (D3), SHA256 so the duplicate-hash check skips unchanged rescans.
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
    data.virusScanMessage = stripNul(outcome.virusScan.message);
  }

  if (outcome.pickleScan) {
    const verdict = pickleVerdictFor(outcome.pickleScan, file);
    data.pickleScanResult = verdict.result;
    data.pickleScanMessage = verdict.message;
  }

  // Stripped once: SSHS_12 below is derived from this header and lands in a text column too.
  const headerData = stripNul(outcome.headerData);
  if (headerData !== undefined) {
    data.headerData = headerData as Prisma.InputJsonValue;
  }

  if (outcome.rawScanResult !== undefined) {
    data.rawScanResult = stripNul(outcome.rawScanResult) as Prisma.InputJsonValue;
  }

  const written = await dbWrite.modelFile.update({
    where: { id: fileId, ...sameBytes },
    data,
    select: { pickleScanResult: true, virusScanResult: true },
  });
  const failedScan = ranScan && hasFailedScan(written);
  const coverageMoved =
    ranScan &&
    (excludedFromCoverage({ ...written, type: file.type }) || excludedFromCoverage(file));

  // Hash upsert (delete + createMany) — same pattern as legacy.
  if (outcome.hashes) {
    const hashRows = (
      Object.entries(
        // outcome.headerData is absent on a hash-only rescan, and this rebuild deletes every row
        // for the file — so the stored column is what keeps SSHS_12 from being dropped.
        normalizeScanHashes(outcome.hashes, headerData ?? file.headerData)
      ) as Array<[ModelHashType, string]>
    )
      .filter(([, hash]) => Boolean(hash))
      .map(([type, hash]) => ({ fileId, type, hash }));

    if (hashRows.length > 0) {
      await dbWrite.$transaction([
        dbWrite.modelFileHash.deleteMany({ where: { fileId } }),
        dbWrite.modelFileHash.createMany({ data: hashRows }),
      ]);

      // Entity-change audit: record the file's SHA256 lineage. First scan writes
      // '' → hash; a re-upload writes old → new. "Did the file change after
      // upload" = more than one distinct newValue for this fileId. Rescans of
      // unchanged bytes diff equal and emit nothing.
      const newSha256 = outcome.hashes.SHA256;
      if (newSha256) {
        const existingSha256 = existingHashes.find((h) => h.type === ModelHashType.SHA256)?.hash;
        const changeRows = diffEntityChanges({
          entityType: 'ModelFile',
          entityId: fileId,
          ownerId: file.modelVersion?.model?.userId ?? 0,
          before: { 'hash.SHA256': existingSha256 },
          after: { 'hash.SHA256': newSha256 },
          actorRole: 'system',
          reason: 'file-scan',
        });
        new Tracker().entityChanges(changeRows).catch(() => null);
      }
    }

    const scannedSha256 = outcome.hashes.SHA256;
    const scannedModelId = file.modelVersion?.modelId;
    const scannedUserId = file.modelVersion?.model?.userId;
    // Scan requests aren't type-filtered, but the sweep and the review queue
    // both only cover MINOR_HASH_FILE_TYPE. Without this gate a Training
    // Data/VAE/Config match would auto-flag on a path no sweep reaches, or
    // queue for a review page that can never surface it.
    if (
      scannedSha256 &&
      scannedModelId &&
      scannedUserId &&
      file.type === MINOR_HASH_FILE_TYPE &&
      // Checked last so the kill switch is the only thing evaluated per scan
      // once the cheap local gates have already excluded the file.
      (await isFlipt(FLIPT_FEATURE_FLAGS.MINOR_HASH_AUTO_FLAG))
    ) {
      await checkMinorHashOnScan({
        fileId,
        modelId: scannedModelId,
        userId: scannedUserId,
        sha256: scannedSha256,
      });
    }
    if (
      scannedSha256 &&
      scannedModelId &&
      scannedUserId &&
      file.type === MINOR_HASH_FILE_TYPE &&
      (await isFlipt(FLIPT_FEATURE_FLAGS.POI_HASH_AUTO_FLAG))
    ) {
      await checkPoiHashOnScan({
        fileId,
        modelId: scannedModelId,
        userId: scannedUserId,
        sha256: scannedSha256,
      });
    }

    const scannedModel = file.modelVersion?.model;
    if (scannedSha256 && scannedModelId && scannedModel) {
      await checkDuplicateHashOnScan({
        fileId,
        fileType: file.type,
        sizeKB: file.sizeKB,
        sha256: scannedSha256,
        previousSha256: existingHashes.find((h) => h.type === ModelHashType.SHA256)?.hash,
        modelId: scannedModelId,
        ownerId: scannedModel.userId,
        modelStatus: scannedModel.status,
      }).catch((e) =>
        logToAxiom(
          {
            type: 'warning',
            name: 'duplicate-model-hash',
            message: (e as Error).message,
            fileId,
          },
          'webhooks'
        ).catch(() => null)
      );
    }
  }

  // Safety net for uploads that slipped past the client-side check: a non-official
  // upload whose bytes match an official file is replaced by a pointer to that file,
  // and the upload's row + S3 object are deleted (replaceFileId → deleteFile, which
  // GCs the bytes) to reclaim storage. Skip primary-typed files — addLinkedComponent
  // refuses to delete primary weights (replaceFileId guard), so we can't reclaim them
  // here; the client prevents that case before upload.
  const sha256 = outcome.hashes?.SHA256;
  if (
    sha256 &&
    file.modelVersion?.model?.userId !== constants.system.officialUserId &&
    !primaryModelFileTypes.includes(file.type as ModelFileType)
  ) {
    try {
      const match = await findOfficialFileByHash({ sha256 });
      if (match) {
        await addLinkedComponent({
          id: file.modelVersionId,
          targetVersionId: match.versionId,
          targetFileId: match.fileId,
          replaceFileId: file.id,
          componentType: match.componentType,
          modelId: match.modelId,
          modelName: match.modelName,
          versionName: match.versionName,
          isRequired: true,
          userId: constants.system.officialUserId,
          isModerator: true,
        });
      }
    } catch (e) {
      logToAxiom(
        {
          type: 'warning',
          name: 'post-scan-official-dedup',
          message: (e as Error).message,
          fileId,
        },
        'webhooks'
      ).catch(() => null);
    }
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

  if (failedScan) {
    await unpublishForFailedScan(modelVersionId).catch((e) =>
      logToAxiom(
        {
          type: 'error',
          name: 'model-file-scan',
          message: `failed-scan unpublish failed: ${String(e)}`,
          modelVersionId,
        },
        'webhooks'
      ).catch(() => undefined)
    );
  }

  // A first scan of a weight file can make a version coverable (`scannedAt` gates the uploaded-file
  // arms of GenerationCoverage), and both caches hold the old answer — the orchestrator's until
  // expiry, resourceDataCache for an hour. Last and logged, not thrown: the scan result is
  // already written, and a throw would make the orchestrator redeliver the whole workflow.
  // A failed scan of any file, or an errored scan of a loadable one, uncovers the version, and a
  // clean rescan recovers it, so both bust too.
  if (coverageMoved || (ranScan && LOADABLE_FILE_TYPES.includes(file.type)))
    await Promise.all([
      resourceDataCache.bust([modelVersionId]),
      bustOrchestratorModelCache(modelVersionId),
      coverageMoved &&
        file.modelVersion &&
        bustVersionScannedFileAirs(modelVersionId, file.modelVersion),
    ]).catch((e) =>
      logToAxiom(
        {
          type: 'error',
          name: 'model-file-scan',
          message: `coverage bust failed: ${String(e)}`,
          modelVersionId,
        },
        'webhooks'
      ).catch(() => undefined)
    );
}

// Text encoders are opened by loaders outside the generator too.
export const PICKLE_LOADED_FILE_TYPES = [...LOADABLE_FILE_TYPES, 'Text Encoder'];

function pickleVerdictFor(
  pickleScan: NonNullable<ScanOutcome['pickleScan']>,
  file: { type: string; name: string }
) {
  const { unread: reason } = pickleScan;
  const unread =
    PICKLE_LOADED_FILE_TYPES.includes(file.type) &&
    (reason === 'unknown-format' ||
      (reason === 'nothing-read' && !file.name.toLowerCase().endsWith('.zip')));
  return unread
    ? { result: ScanResultCode.Error, message: PICKLE_NOT_READ_MESSAGE }
    : { result: pickleScan.result, message: stripNul(pickleScan.message) };
}

/**
 * The result of a scan-only rescan. It writes the pickle verdict (an unread one as Error, as for any
 * scan) and the virus verdict only when that finds something, and only over the Success the file was
 * selected with. It rebuilds no hashes, runs no hash checks and unpublishes nothing; a changed
 * verdict refreshes caches and search. A Pending pickle result is not written, so the file stays
 * selected. Every result is logged, with every Danger the scanner returned, written or not.
 */
export async function applyScanOnlyOutcome(outcome: ScanOutcome): Promise<void> {
  const { fileId } = outcome;
  const file = await dbWrite.modelFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      name: true,
      type: true,
      modelVersionId: true,
      pickleScanResult: true,
      virusScanResult: true,
      hashes: { select: { type: true, hash: true } },
      modelVersion: {
        select: { status: true, modelId: true, baseModel: true, model: { select: { type: true } } },
      },
    },
  });
  const log = (type: 'info' | 'warning', fields: Record<string, unknown>) =>
    logToAxiom({ type, name: 'scan-only-rescan', fileId, ...fields }, 'webhooks').catch(
      () => undefined
    );
  if (!file || file.type === 'Training Data') return void log('warning', { skipped: 'file' });

  const verdict = outcome.pickleScan && pickleVerdictFor(outcome.pickleScan, file);
  const pickle = verdict && verdict.result !== ScanResultCode.Pending ? verdict : undefined;
  const virusDanger = outcome.virusScan?.result === ScanResultCode.Danger;
  if (!pickle && !virusDanger)
    return void log('warning', { kept: file.pickleScanResult, result: verdict?.result ?? null });

  // A Pending result leaves rawScanResult as stored, so the file stays selected.
  const data: Prisma.ModelFileUpdateManyMutationInput = { scannedAt: new Date() };
  if (pickle) {
    data.pickleScanResult = pickle.result;
    data.pickleScanMessage = pickle.message;
    data.rawScanResult = stripNul(outcome.rawScanResult) as Prisma.InputJsonValue;
  }
  if (virusDanger) {
    data.virusScanResult = ScanResultCode.Danger;
    data.virusScanMessage = stripNul(outcome.virusScan?.message ?? null);
  }
  // Only over the verdict the file was selected with: a reset or a newer verdict since the submit
  // stands.
  const { count } = await dbWrite.modelFile.updateMany({
    where: { id: fileId, pickleScanResult: ScanResultCode.Success },
    data,
  });
  if (!count) {
    const found = pickle?.result === ScanResultCode.Danger || virusDanger;
    return void log('warning', { skipped: 'verdict changed since submit', danger: found });
  }
  const pickleAfter = pickle?.result ?? file.pickleScanResult;

  const stored = (type: ModelHashType) => file.hashes.find((h) => h.type === type)?.hash;
  const differs = (type: ModelHashType) => {
    const next = outcome.hashes?.[type];
    return !!next && next.toLowerCase() !== stored(type)?.toLowerCase();
  };
  const danger = pickleAfter === ScanResultCode.Danger || virusDanger;
  log(danger ? 'warning' : 'info', {
    modelVersionId: file.modelVersionId,
    live: PUBLIC_MODEL_STATUSES.includes(file.modelVersion.status),
    before: { pickle: file.pickleScanResult, virus: file.virusScanResult },
    after: {
      pickle: pickleAfter,
      virus: virusDanger ? ScanResultCode.Danger : file.virusScanResult,
    },
    danger,
    sha256Changed: differs(ModelHashType.SHA256),
    autoV2Changed: differs(ModelHashType.AutoV2),
  });

  const changed =
    pickleAfter !== file.pickleScanResult ||
    (virusDanger && file.virusScanResult !== ScanResultCode.Danger);
  if (!changed) return;
  await deleteFilesForModelVersionCache(file.modelVersionId);
  await modelsSearchIndex.queueUpdate([
    { id: file.modelVersion.modelId, action: SearchIndexUpdateQueueAction.Update },
  ]);
  const virusAfter = virusDanger ? ScanResultCode.Danger : file.virusScanResult;
  const coverageMoved =
    excludedFromCoverage(file) !==
    excludedFromCoverage({
      type: file.type,
      pickleScanResult: pickleAfter,
      virusScanResult: virusAfter,
    });
  if (coverageMoved || LOADABLE_FILE_TYPES.includes(file.type))
    await Promise.all([
      resourceDataCache.bust([file.modelVersionId]),
      bustOrchestratorModelCache(file.modelVersionId),
      coverageMoved && bustVersionScannedFileAirs(file.modelVersionId, file.modelVersion),
    ]).catch((e) => log('warning', { bust: String(e) }));
}

const FAILURE_BUST_TTL_SECONDS = 60 * 60;

type FailedScanFile = {
  id: number;
  modelVersionId: number;
  modelVersion: { modelId: number; baseModel: string; model: { type: ModelType } };
};

// The orchestrator caches answers for hours per exact AIR, so one cached during an outage fails
// every retry until busted. The scan's file-pinned AIR is a separate entry from the version's.
// Logged, not thrown, so the retry bump already written stands.
async function bustAfterFailedScan(modelVersionId: number, file: FailedScanFile) {
  try {
    const prefix = REDIS_SYS_KEYS.WEBHOOKS.MODEL_FILE_SCAN_FAILURE_BUST;
    const [bustVersion, bustFile] = await Promise.all([
      sysRedis.setNxKeepTtlWithEx(`${prefix}:${modelVersionId}`, '1', FAILURE_BUST_TTL_SECONDS),
      sysRedis.setNxKeepTtlWithEx(`${prefix}:file:${file.id}`, '1', FAILURE_BUST_TTL_SECONDS),
    ]);
    await Promise.all([
      bustVersion && bustOrchestratorModelCache(modelVersionId),
      bustFile &&
        bustOrchestratorScannedFileCache({
          fileId: file.id,
          modelVersionId: file.modelVersionId,
          modelId: file.modelVersion.modelId,
          modelType: file.modelVersion.model.type,
          baseModel: file.modelVersion.baseModel,
        }),
    ]);
  } catch (e) {
    logToAxiom(
      {
        type: 'error',
        name: 'model-file-scan',
        message: `failed-scan bust failed: ${String(e)}`,
        modelVersionId,
        fileId: file.id,
      },
      'webhooks'
    ).catch(() => undefined);
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

const AUTOV3_LENGTH = 12;
const SHA256_12_LENGTH = 12;
const SSHS_12_LENGTH = 12;

/**
 * `left(sshs_model_hash, 12)` from a safetensors header, or undefined when the file has no such key.
 *
 * Stored verbatim, prefix included. A1111/Forge read `sshs_model_hash` out of the header in
 * preference to hashing the file and truncate it to 12 characters for the infotext, so when the
 * trainer wrote a `0x` prefix only 10 hex digits survive — and the value under that prefix is
 * computed at training time over a re-serialisation, so it is not derivable from the shipped file's
 * bytes and does not equal AutoV3. Measured on prod: of 3,109 prefixed files, stripping `0x` and
 * comparing against AutoV3 matched 1. See docs/image-resource-hash-matching.md.
 */
export function deriveSshsHash(headerData: unknown): string | undefined {
  if (!headerData || typeof headerData !== 'object' || Array.isArray(headerData)) return undefined;
  const raw = (headerData as Record<string, unknown>).sshs_model_hash;
  if (typeof raw !== 'string') return undefined;

  const short = raw.trim().toLowerCase().slice(0, SSHS_12_LENGTH);
  return short.length === SSHS_12_LENGTH ? short : undefined;
}

const orchestratorHashFieldMap: Record<string, ModelHashType> = {
  sha256: ModelHashType.SHA256,
  autoV1: ModelHashType.AutoV1,
  autoV2: ModelHashType.AutoV2,
  autoV3: ModelHashType.AutoV3,
  blake3: ModelHashType.BLAKE3,
  crc32: ModelHashType.CRC32,
};
/**
 * Canonical stored form of the orchestrator's hash step output.
 *
 * Two adjustments, both idempotent so re-running over already-normalized values is a no-op:
 *
 *   AutoV3     arrives full-length (per @civitai/orchestration-client: "SHA256 of the file with safetensors
 *              header metadata stripped"). We store 12 chars, the width A1111 writes.
 *   SHA256_12  is sent by nothing. It is sha256[0:12] — the width A1111/Forge write for LoRAs,
 *              which no other stored hash matches, so resource detection fails without it.
 *              See docs/image-resource-hash-matching.md.
 *
 * Every writer of ModelFileHash that can carry a hash the orchestrator produced must run it
 * through this. There are THREE writers, and the ledger test enumerates them from source —
 * src/server/services/__tests__/model-file-hash-writers.test.ts fails when the set grows OR
 * shrinks, so a new writer forces a decision here rather than inheriting one:
 *
 *   applyScanOutcome (this file)                     normalizes
 *   /api/mod/reprocess-scan                          normalizes
 *   createModelFileScanRequest's dev-only skip       EXEMPT — see below
 *     (orchestrator/orchestrator.service.ts)
 *
 * The exemption is not "it's dev-only": it is that the sentinel that writer stores (SHA256 =
 * 64 zeroes, "file unreachable") is a fixed point of this function, so calling it there would
 * change nothing. That is a property of both modules at once, so it is pinned behaviourally in
 * src/server/services/orchestrator/__tests__/createModelFileScanRequest.test.ts — change the
 * sentinel, or drop the all-zero guard below, and that test goes red.
 *
 * This is the ONLY thing enforcing the AutoV3 width. A truncate_autov3_hash trigger used to do
 * it in the database as well, and is dropped in migration 20260819010000 once this ships — so a
 * writer that skips this helper stores a 64-char AutoV3 and silently breaks matching for the
 * type carrying ~85-88% of LoRA references.
 *
 * AutoV1, AutoV2, BLAKE3, CRC32 and SHA256 pass through untouched — the orchestrator is the
 * authority for those, and re-deriving them here would put two systems in charge of one value.
 */
export function normalizeScanHashes(
  hashes: Partial<Record<ModelHashType, string>>,
  headerData?: unknown
): Partial<Record<ModelHashType, string>> {
  const out: Partial<Record<ModelHashType, string>> = { ...hashes };

  if (out.AutoV3) out.AutoV3 = out.AutoV3.slice(0, AUTOV3_LENGTH);

  // The scan-request path writes an all-zero SHA256 as a "file unreachable" sentinel. Deriving
  // from it would give every such file the same 12-char hash and make them match each other.
  const sha256 = out.SHA256;
  if (sha256 && !/^0+$/.test(sha256)) out.SHA256_12 = sha256.slice(0, SHA256_12_LENGTH);

  // Only added when no other row already carries the value — sshs_model_hash equals AutoV3 for
  // ~98% of files, and a duplicate row matches nothing the sibling would not have matched.
  const sshs = deriveSshsHash(headerData);
  if (sshs && !Object.values(out).some((hash) => hash?.toLowerCase() === sshs)) out.SSHS_12 = sshs;

  return out;
}

/** Clam statuses for a file the scanner could not fully read: never clean, and not malware. */
const UNVERIFIED_CLAM_STATUSES = new Set(['encrypted', 'limitsexceeded']);

const CLAM_FOUND_LINE = /:\s(\S+)\sFOUND\s*$/gm;
const isUnverifiedSignature = (sig: string) =>
  sig.startsWith('Heuristics.Encrypted.') || sig.startsWith('Heuristics.Limits.Exceeded');

/**
 * The verdict the scanner's FOUND lines give, or null when they give none. Encrypted and over-limit
 * alerts share exit codes with errors and with clean scans, so the exit code cannot tell them apart.
 */
function clamSignatureResult(text: string | null | undefined): ScanResultCode | null {
  const signatures = [...(text ?? '').matchAll(CLAM_FOUND_LINE)].map((match) => match[1]);
  if (signatures.some((sig) => !isUnverifiedSignature(sig))) return ScanResultCode.Danger;
  if (signatures.length) return ScanResultCode.Error;
  return null;
}

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
    if (UNVERIFIED_CLAM_STATUSES.has(status)) return ScanResultCode.Error;
    if (status.includes('error') || status.includes('fail')) return ScanResultCode.Error;
    return ScanResultCode.Pending;
  }
  // Exit 1 stays Danger whatever the alerts say.
  if (output.exitCode === 1) return ScanResultCode.Danger;
  return clamSignatureResult(output.output) ?? exitCodeToScanResult(output.exitCode);
}

const PICKLE_NOT_READ_MESSAGE = 'The pickle scan could not read this file';

type PickleScanOutput = NonNullable<ModelPickleScanStep['output']>;
type ScanOutcomeUnread = NonNullable<NonNullable<ScanOutcome['pickleScan']>['unread']>;

const FORMAT_SKIP_STATUSES = new Set(['skippedsafetensors', 'skippedgguf']);

/** Why the scanner read no pickle, if it read none; undefined when it read the file or skipped a
 *  format that cannot hold pickled code. picklescan exits 0, and the step reports clean, when it
 *  found no pickle to read. */
function pickleUnreadReason(output: PickleScanOutput): ScanOutcomeUnread | undefined {
  const status = output.status?.toLowerCase();
  const skipped = status ? status.startsWith('skipped') : output.skipped === true;
  if (skipped) {
    const formatSkip = status
      ? FORMAT_SKIP_STATUSES.has(status)
      : /^(safetensors|gguf)/.test(output.skipReason ?? '');
    return formatSkip ? undefined : 'unknown-format';
  }
  const clean = status ? status === 'clean' : output.exitCode === 0;
  return clean && clamFilesScanned(output) === 0 ? 'nothing-read' : undefined;
}

function derivePickleScanResult(output: PickleScanOutput): ScanResultCode {
  if (output.dangerousImportsFound === true) return ScanResultCode.Danger;
  const status = output.status?.toLowerCase();
  if (status) {
    if (status === 'clean' || status.startsWith('skipped')) return ScanResultCode.Success;
    if (status.includes('danger') || status.includes('infect')) return ScanResultCode.Danger;
    if (status.includes('error') || status.includes('fail')) return ScanResultCode.Error;
    return ScanResultCode.Pending;
  }
  if (output.skipped === true) return ScanResultCode.Success;
  return exitCodeToScanResult(output.exitCode);
}

// Webhook callbacks can fire more than once per workflow (orchestrator retries,
// fan-out from multiple terminal event types). Dedupe on workflowId before any
// side-effect so duplicate deliveries don't double-write DB rows, double-bump
// `scanRequestedAt`, or double-invalidate caches. 1h TTL covers retry windows
// while keeping the key cardinality bounded.
const SCAN_CALLBACK_DEDUPE_TTL_SECONDS = 60 * 60;

export async function processModelFileScanResult(req: NextApiRequest) {
  const event: WorkflowEvent = req.body;

  if (event.workflowId) {
    const dedupeKey =
      `${REDIS_SYS_KEYS.WEBHOOKS.MODEL_FILE_SCAN_PROCESSED}:${event.workflowId}` as const;
    const acquired = await sysRedis.setNxKeepTtlWithEx(
      dedupeKey,
      '1',
      SCAN_CALLBACK_DEDUPE_TTL_SECONDS
    );
    if (!acquired) {
      logToAxiom(
        {
          type: 'info',
          name: 'model-file-scan-result',
          message: `Duplicate callback suppressed for workflow ${event.workflowId}`,
          workflowId: event.workflowId,
          status: event.status,
          duplicate: true,
        },
        'webhooks'
      ).catch();
      return;
    }

    // A throw becomes a 500 and the orchestrator redelivers, but the key taken above would
    // suppress that redelivery as a duplicate and the result would be lost for good.
    try {
      await handleScanWorkflow(event);
    } catch (error) {
      await sysRedis.del(dedupeKey).catch((e) =>
        logToAxiom(
          {
            type: 'error',
            name: 'model-file-scan-result',
            message: `Failed to release dedupe key: ${String(e)}`,
            workflowId: event.workflowId,
          },
          'webhooks'
        ).catch(() => undefined)
      );
      throw error;
    }
    return;
  }

  await handleScanWorkflow(event);
}

async function handleScanWorkflow(event: WorkflowEvent) {
  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId: event.workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${event.workflowId}`);

  const fileId = data.metadata?.fileId as number | undefined;
  if (!fileId) throw new Error(`missing workflow metadata.fileId - ${event.workflowId}`);

  const modelVersionId = data.metadata?.modelVersionId as number | undefined;
  const trainingDataUrl =
    data.metadata?.scan === TRAINING_DATA_BLOB_SCAN
      ? (data.metadata?.url as string | undefined)
      : undefined;

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
    await applyScanOutcome({ fileId, modelVersionId, trainingDataUrl, failed: true });
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
    trainingDataUrl,
    rawScanResult: { source: 'orchestrator', workflowId: event.workflowId, steps },
  };

  if (clamScan?.output) {
    const derived = deriveClamScanResult(clamScan.output);
    // A zip's scan that read no files has not cleared it.
    const readNothing =
      !!trainingDataUrl &&
      derived === ScanResultCode.Success &&
      clamFilesScanned(clamScan.output) === 0;
    const result = readNothing ? ScanResultCode.Error : derived;
    outcome.virusScan = {
      result,
      message: readNothing
        ? 'The virus scan read no files'
        : result !== ScanResultCode.Success
        ? clamScan.output.output ?? null
        : null,
    };

    if (
      trainingDataUrl &&
      result === ScanResultCode.Success &&
      !(await trainingDataObjectUnchanged({
        fileId,
        url: trainingDataUrl,
        etag: data.metadata?.etag,
        size: data.metadata?.size,
      }))
    ) {
      // Not confirmed as the object that was scanned: it stays Pending, and the self-heal scans it again.
      const { count: reset } = await dbWrite.modelFile.updateMany({
        where: {
          id: fileId,
          url: trainingDataUrl,
          type: 'Training Data',
          // A Danger stands; an Error the self-heal gave up on stays given up.
          virusScanResult: { notIn: [ScanResultCode.Danger, ScanResultCode.Error] },
        },
        data: {
          virusScanResult: ScanResultCode.Pending,
          virusScanMessage: null,
          scanRequestedAt: new Date(),
        },
      });
      if (reset && data.metadata?.op === HEAL_OP)
        await uncountUnconfirmedResubmit({
          fileId,
          url: trainingDataUrl,
          workflowId: event.workflowId,
        });
      logToAxiom(
        {
          type: 'warning',
          name: 'training-data-scan-unconfirmed',
          fileId,
          workflowId: event.workflowId,
        },
        'webhooks'
      ).catch();
      return;
    }
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
    const result = hasDanger ? ScanResultCode.Danger : baseResult;
    outcome.pickleScan = {
      result,
      message: result === ScanResultCode.Error ? PICKLE_NOT_READ_MESSAGE : pickleScanMessage,
      dangerousImports: pickleOut.dangerousImports ?? undefined,
      unread: hasDanger ? undefined : pickleUnreadReason(pickleOut),
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

  await (data.metadata?.op === SCAN_ONLY_RESCAN_OP ? applyScanOnlyOutcome : applyScanOutcome)(
    outcome
  );

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
// rescanModel — admin/moderator-driven re-scan dispatch via the orchestrator.
// -----------------------------------------------------------------------------

export const rescanModel = async ({ id }: GetByIdInput) => {
  const modelFiles = await dbRead.modelFile.findMany({
    where: { modelVersion: { modelId: id } },
    select: {
      id: true,
      url: true,
      type: true,
      sizeKB: true,
      modelVersion: {
        select: {
          id: true,
          baseModel: true,
          model: { select: { id: true, type: true } },
        },
      },
    },
  });

  if (modelFiles.length === 0) return { sent: 0, failed: 0 };

  const sent: number[] = [];
  const failed: number[] = [];

  const tasks = modelFiles.map((file) => async () => {
    // Soft-deleted version → orphaned file. Skip rather than crash.
    if (!file.modelVersion) {
      failed.push(file.id);
      return;
    }
    if (file.type === 'Training Data') {
      // A Training Studio placeholder has no zip until the archive job swaps one in, and scans it then.
      if (!file.sizeKB) return;
      const submitted = await submitTrainingDataScanSafe(
        { fileId: file.id, modelVersionId: file.modelVersion.id, url: file.url },
        'rescan-model'
      );
      (submitted ? sent : failed).push(file.id);
      return;
    }
    try {
      await createModelFileScanRequest({
        fileId: file.id,
        modelVersionId: file.modelVersion.id,
        modelId: file.modelVersion.model.id,
        modelType: file.modelVersion.model.type as ModelType,
        baseModel: file.modelVersion.baseModel,
        url: file.url,
        priority: 'normal',
      });
      sent.push(file.id);
    } catch (err) {
      failed.push(file.id);
      // Admin-triggered rescan: caller has explicit intent and the file's
      // been around long enough to settle. Mirror scanFilesFallbackJob and
      // tombstone on a 'not-found' so this rescan doesn't keep churning on
      // a permanently dead AIR.
      if (err instanceof ModelFileScanSubmissionError && err.code === 'not-found') {
        await dbWrite.modelFile
          .update({ where: { id: file.id }, data: { exists: false } })
          .catch(() => null);
      }
    }
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

export async function unpublishForFailedScan(modelVersionId: number) {
  const live: ModelStatus[] = [ModelStatus.Published, ModelStatus.Scheduled];
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: { status: true, meta: true, modelId: true },
  });
  if (!version || !live.includes(version.status)) return;

  // Not resolveUnpublishScope: it never cascades from a Scheduled version, and a Scheduled model
  // left with no live version stays Scheduled for good.
  const liveSiblings = await dbWrite.modelVersion.count({
    where: { modelId: version.modelId, status: { in: live }, id: { not: modelVersionId } },
  });
  const reason = 'failed-scan';
  if (!liveSiblings) {
    await unpublishModelById({ id: version.modelId, reason, userId: -1, isModerator: true });
  } else {
    await unpublishModelVersionById({
      id: modelVersionId,
      reason,
      // Written back whole, so it carries the stored meta.
      meta: (version.meta as ModelMeta | null) ?? undefined,
      user: { id: -1, isModerator: true },
    });
  }
}

export async function unpublishBlockedModel(modelVersionId: number) {
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: { id: true, model: { select: { id: true } } },
  });
  if (!version?.model?.id) return;

  await unpublishModelById({
    id: version.model.id,
    reason: 'duplicate',
    customMessage: 'Model has been unpublished due to matching a blocked hash',
    userId: -1,
    isModerator: true,
  });
}
