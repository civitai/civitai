import type { Prisma } from '@prisma/client';
import type { WorkflowEvent } from '@civitai/client';
import { getWorkflow } from '@civitai/client';
import type { NextApiRequest } from 'next';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { modelsSearchIndex } from '~/server/search-index';
import {
  deleteFilesForModelVersionCache,
  findOfficialFileByHash,
} from '~/server/services/model-file.service';
import { unpublishModelById } from '~/server/services/model.service';
import { checkMinorHashOnScan, MINOR_HASH_FILE_TYPE } from '~/server/services/minor-hash.service';
import { createNotification } from '~/server/services/notification.service';
import {
  createModelFileScanRequest,
  ModelFileScanSubmissionError,
} from '~/server/services/orchestrator/orchestrator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { constants } from '~/server/common/constants';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { ModelHashType, ModelStatus, ScanResultCode } from '~/shared/utils/prisma/enums';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import type { ModelFileType } from '~/server/common/constants';
import { addLinkedComponent } from '~/server/services/model-version.service';
import { Tracker } from '~/server/clickhouse/client';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';

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
  /**
   * The file's declared container format is contradicted by its bytes — it is not the kind of
   * file it claims to be. Distinct from a generic scan Error: this one names a deliberate
   * disguise, so it is the signal the moderator-hold path keys on.
   */
  formatMismatch?: boolean;
  /**
   * The scanner's own explanation of the mismatch, for the operator log ONLY.
   *
   * Kept separate from `pickleScan.message` on purpose: that field is served by the public v1
   * API and is therefore a fixed string. An earlier revision passed the public constant to the
   * log as well, which left a moderator working the queue with no idea which format was
   * declared or what was actually detected.
   */
  formatMismatchDetail?: string | null;
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
      type: true,
      modelVersionId: true,
      modelVersion: { select: { modelId: true, model: { select: { userId: true } } } },
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
    const hashRows = (
      Object.entries(normalizeScanHashes(outcome.hashes)) as Array<[ModelHashType, string]>
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

  // A file that is not the kind of file it claims to be. The scan result above already records
  // this as non-clean, so the model cannot show a Verified shield either way; this adds the
  // human-in-the-loop step. Gated, and deliberately AFTER the result is persisted, so a failure
  // here can never swallow the recorded verdict.
  if (outcome.formatMismatch && file.modelVersion?.modelId) {
    await holdModelForFormatMismatch({
      modelId: file.modelVersion.modelId,
      fileId,
      detail: outcome.formatMismatchDetail ?? null,
    }).catch((err) =>
      logToAxiom(
        {
          type: 'error',
          name: 'apply-scan-outcome',
          message: 'format-mismatch hold failed',
          fileId,
          modelId: file.modelVersion?.modelId,
          error: err instanceof Error ? err.message : String(err),
        },
        'webhooks'
      ).catch()
    );
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

/**
 * Puts a model whose file contradicts its declared format in front of a moderator.
 *
 * Uses the existing Hold semantics (`unpublishModelById` + `meta.needsReview`) — the same path
 * `ModerationRuleAction.Hold` takes, so the uploader gets the "under review" banner.
 *
 * 🔴 BE PRECISE ABOUT WHAT THIS DOES. `unpublishModelById` sets `UnpublishedViolation` whenever
 * a `reason` is passed — ANY truthy reason, `'other'` included; see the
 * `status: reason ? UnpublishedViolation : …` ternary in model.service.ts — and it applies to
 * the model AND every one of its versions. `UnpublishedViolation` is in
 * `constants.modPublishOnlyStatuses`, so the CREATOR CANNOT REPUBLISH; only a moderator can.
 * An earlier revision of this comment claimed this was "not an UnpublishedViolation" and
 * "non-punitive". That was simply false.
 *
 * It is worth naming, because the obvious correction is worse than the defect: dropping
 * `reason` to obtain a plain `Unpublished` would remove the model from the moderator queue at
 * /moderator/models, which selects on `[UnpublishedViolation, Published]` — it would be held
 * where no reviewer can find it. The mod-only status and the review queue are one mechanism.
 *
 * The model does come down while it waits. That is deliberate: leaving it published pending
 * review is precisely the window in which a disguised file is still reachable by users.
 *
 * Expected volume is small — the magic-byte check distinguishes legitimate containers from
 * genuine mismatches, so only the latter reach this path. Sizing is in the internal ticket.
 */
async function holdModelForFormatMismatch({
  modelId,
  fileId,
  detail,
}: {
  modelId: number;
  fileId: number;
  detail: string | null;
}) {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.SCAN_FORMAT_MISMATCH_HOLD))) return;

  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { id: true, name: true, meta: true, userId: true, status: true },
  });
  if (!model) return;

  // 🔴 LOGGED BEFORE ANY STATUS BRANCH, DELIBERATELY. An earlier revision returned above this
  // line for every non-published model, which meant the single most common case — a mismatch
  // found while the model is still a Draft — produced NO hold, NO queue entry and NO log. It
  // was invisible. Whatever we decide to do about the model, the detection itself is always
  // recorded.
  logToAxiom(
    {
      type: 'warning',
      name: 'scan-format-mismatch',
      message: `File ${fileId} on model ${modelId} does not match its declared format`,
      modelId,
      fileId,
      modelStatus: model.status,
      detail,
    },
    'webhooks'
  ).catch();

  // 🔴 UNPUBLISHING IS ONLY MEANINGFUL FOR SOMETHING THAT IS PUBLISHED, and doing it to
  // anything else causes real harm — a never-published Draft would be pushed to
  // UnpublishedViolation, which its own creator cannot undo (mod-only republish).
  //
  // But "don't unpublish a Draft" must not become "ignore a Draft". Files are scanned by
  // scan-files.ts, which has NO model-status predicate, and models are created Draft with
  // files attached during the upload wizard — so the FIRST upload of a disguised file is
  // normally scanned while still a draft. Nothing re-scans it later, and the publish path does
  // not consult scan results, so simply returning here would let it be published afterwards
  // with no further checks. That is the mirror of the bug this branch was added to fix.
  //
  // (For the record: the per-VERSION unpublish notification is already status-scoped in
  // model.service.ts and would not fire for a draft's versions. The harm that motivates this
  // branch is the model-level UnpublishedViolation lockout, not that notification.)
  //
  // So a non-published model is FLAGGED but not unpublished: meta.needsReview is what the
  // moderator queue keys on, and setting it costs the creator nothing.
  if (model.status !== ModelStatus.Published && model.status !== ModelStatus.Scheduled) {
    await dbWrite.model.update({
      where: { id: modelId },
      data: { meta: { ...(model.meta as ModelMeta), needsReview: true } as Prisma.InputJsonValue },
    });
    return;
  }

  await unpublishModelById({
    id: modelId,
    userId: -1,
    reason: 'other',
    // Same reasoning as FORMAT_MISMATCH_PUBLIC_MESSAGE — this reaches the uploader, who is the
    // one party we must not hand a detector readout to. The scanner's text goes to the log
    // above via `detail`; it is never echoed to the creator or to the public API.
    customMessage:
      'Model held for review: an uploaded file could not be verified as the file type it declares.',
    meta: { ...(model.meta as ModelMeta), needsReview: true },
    isModerator: true,
  });

  logToAxiom(
    {
      type: 'warning',
      name: 'scan-format-mismatch-hold',
      message: `Model ${modelId} held: file ${fileId} does not match its declared format`,
      modelId,
      fileId,
      detail,
    },
    'webhooks'
  ).catch();

  await createNotification({
    category: NotificationCategory.System,
    key: `model-format-mismatch:${modelId}:${fileId}`,
    type: 'system-message',
    userId: model.userId,
    details: {
      message: `Your model "${model.name}" has been put on hold because an uploaded file does not appear to be the file type it claims to be. A moderator will review it shortly.`,
      url: `/models/${modelId}`,
    },
  }).catch((error) =>
    logToAxiom(
      {
        type: 'error',
        name: 'scan-format-mismatch-hold',
        message: 'Could not notify uploader of format-mismatch hold',
        modelId,
        error: error.message,
      },
      'webhooks'
    ).catch()
  );
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
    /**
     * ClamAV refused the file for exceeding its size limits, so nothing was inspected.
     * Reported by the scanner as status "Error" (NOT a new status string — the orchestrator
     * parses that field with Enum.TryParse and an unknown value becomes null, which sends the
     * web app to the raw exit code, and a limits bail-out exits 1 exactly like a real
     * detection). This flag carries the true cause for forensics and dashboards.
     */
    limitsExceeded?: boolean | null;
    maxScanSizeMb?: number | null;
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
 *   AutoV3     arrives full-length (per @civitai/client: "SHA256 of the file with safetensors
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
  hashes: Partial<Record<ModelHashType, string>>
): Partial<Record<ModelHashType, string>> {
  const out: Partial<Record<ModelHashType, string>> = { ...hashes };

  if (out.AutoV3) out.AutoV3 = out.AutoV3.slice(0, AUTOV3_LENGTH);

  // The scan-request path writes an all-zero SHA256 as a "file unreachable" sentinel. Deriving
  // from it would give every such file the same 12-char hash and make them match each other.
  const sha256 = out.SHA256;
  if (sha256 && !/^0+$/.test(sha256)) out.SHA256_12 = sha256.slice(0, SHA256_12_LENGTH);

  return out;
}

// Orchestrator now reports scan outcomes via a `status` enum (and explicit
// boolean flags) instead of POSIX exit codes. Map the known status strings,
// fall through to the legacy exitCode path to remain compatible with any
// in-flight workflows that pre-date the orchestrator update.
function deriveClamScanResult(output: NonNullable<ModelClamScanStep['output']>): ScanResultCode {
  if (output.infected === true) return ScanResultCode.Danger;
  // Nothing was inspected, so this is neither clean nor infected. Terminal (Error), not
  // Pending: Pending would put the file back in scan-files-fallback's queue to be retried
  // forever, and the retry cannot succeed — the file is simply larger than ClamAV can scan.
  if (output.limitsExceeded === true) return ScanResultCode.Error;
  const status = output.status?.toLowerCase();
  if (status) {
    if (status === 'clean') return ScanResultCode.Success;
    if (status.includes('infect') || status.includes('danger')) return ScanResultCode.Danger;
    if (status.includes('error') || status.includes('fail')) return ScanResultCode.Error;
    return ScanResultCode.Pending;
  }
  return exitCodeToScanResult(output.exitCode);
}

/**
 * Marker the scanner writes to `skipReason` when a file's declared container format is
 * contradicted by its bytes.
 *
 * Cross-repo contract with spine-controller's ModelPickleScanMiddleware.FormatMismatchReason.
 * The scanner reports the mismatch as ParseError with `skipped: false` and exit code 2, so
 * this string is NOT what makes the result non-clean — it is what tells us the cause was a
 * disguised file rather than a transient scanner fault, which is the difference between
 * "retry it" and "put it in front of a moderator".
 */
export const FORMAT_MISMATCH_SKIP_REASON = 'format-mismatch';

/**
 * What a mismatch shows publicly. Deliberately says nothing about what the scanner detected:
 * this string is served by the public v1 model-versions API, so anything specific here is an
 * oracle an uploader can iterate against. The scanner's full explanation stays in
 * `rawScanResult` and reaches the operator log via ScanOutcome.formatMismatchDetail, which is
 * deliberately a different field from this one.
 */
export const FORMAT_MISMATCH_PUBLIC_MESSAGE =
  'File format could not be verified. This file is under review.';

/**
 * The only skip reasons that represent a container verified from its MAGIC BYTES. Any other
 * skip reason is one the scanner produced without verifying the file's contents.
 */
const BYTE_VERIFIED_SKIP_REASONS = new Set(['safetensors-magic', 'gguf-magic']);

export function isFormatMismatch(
  output: NonNullable<ModelPickleScanStep['output']> | undefined
): boolean {
  return output?.skipReason === FORMAT_MISMATCH_SKIP_REASON;
}

function derivePickleScanResult(
  output: NonNullable<ModelPickleScanStep['output']>,
  { strictSkipVerification }: { strictSkipVerification: boolean }
): ScanResultCode {
  if (output.dangerousImportsFound === true) return ScanResultCode.Danger;

  // 🔴 A SKIP IS NOT A PASS. A skip means the scanner did not inspect the file, and that
  // non-answer must not be recorded as an affirmative clean result.
  //
  // Under strict verification only a byte-verified skip passes. Left off until every worker is
  // on the new scanner build — see the flag's own note for the ordering constraint.
  if (output.skipped === true) {
    if (!strictSkipVerification) return ScanResultCode.Success;
    return output.skipReason && BYTE_VERIFIED_SKIP_REASONS.has(output.skipReason)
      ? ScanResultCode.Success
      : ScanResultCode.Error;
  }

  const status = output.status?.toLowerCase();
  if (status) {
    // `startsWith('skipped')` is deliberately NOT treated as clean here any more. It is
    // reachable with `skipped` unset, and it is the same "we did not look" answer.
    if (status === 'clean') return ScanResultCode.Success;
    if (status.startsWith('skipped')) {
      return strictSkipVerification ? ScanResultCode.Error : ScanResultCode.Success;
    }
    if (status.includes('danger') || status.includes('infect')) return ScanResultCode.Danger;
    if (status.includes('error') || status.includes('fail')) return ScanResultCode.Error;
    return ScanResultCode.Pending;
  }
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
  }

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
    const strictSkipVerification = await isFlipt(FLIPT_FEATURE_FLAGS.SCAN_STRICT_SKIP_VERIFICATION);
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

    const baseResult = derivePickleScanResult(pickleOut, { strictSkipVerification });
    const hasDanger = pickleOut.dangerousImportsFound === true || importsDanger;
    outcome.pickleScan = {
      result: hasDanger ? ScanResultCode.Danger : baseResult,
      // A format mismatch carries no import list, so examinePickleImports produces nothing to
      // show — but the scanner's own explanation must NOT go here. `pickleScanMessage` is
      // returned by the PUBLIC v1 model-versions API, and the scanner's text names what it
      // detected ("detected: Unknown"), which hands an uploader a per-attempt readout of the
      // detector's verdict — a free oracle for tuning a disguise, and one that is reachable
      // while SCAN_FORMAT_MISMATCH_HOLD is off and the model therefore stays published.
      // A fixed string here; the detail is already preserved in rawScanResult for forensics.
      message: isFormatMismatch(pickleOut) ? FORMAT_MISMATCH_PUBLIC_MESSAGE : pickleScanMessage,
      dangerousImports: pickleOut.dangerousImports ?? undefined,
    };
    outcome.formatMismatch = isFormatMismatch(pickleOut);
    // The scanner's text, never the public constant — see formatMismatchDetail.
    outcome.formatMismatchDetail = isFormatMismatch(pickleOut) ? pickleOut.output ?? null : null;
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
// rescanModel — admin/moderator-driven re-scan dispatch via the orchestrator.
// -----------------------------------------------------------------------------

export const rescanModel = async ({ id }: GetByIdInput) => {
  const modelFiles = await dbRead.modelFile.findMany({
    where: { modelVersion: { modelId: id } },
    select: {
      id: true,
      url: true,
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
    try {
      await createModelFileScanRequest({
        fileId: file.id,
        modelVersionId: file.modelVersion.id,
        modelId: file.modelVersion.model.id,
        modelType: file.modelVersion.model.type as ModelType,
        baseModel: file.modelVersion.baseModel,
        url: file.url,
        priority: 'low',
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
