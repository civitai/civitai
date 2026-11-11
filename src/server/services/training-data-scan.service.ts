import { createHash } from 'node:crypto';
import type { WorkflowStepTemplate } from '@civitai/orchestration-client';
import { submitWorkflow } from '@civitai/orchestration-client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { blobAir, uploadConsumerBlob } from '~/server/services/orchestrator/consumer-blob-scan';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { resolveDownloadUrl } from '~/utils/delivery-worker';
import { ModelStatus, ScanResultCode } from '~/shared/utils/prisma/enums';

/**
 * The virus scan for a Training Data zip. The zip is copied to the orchestrator as a consumer blob
 * and scanned there; the scan-result webhook (`processModelFileScanResult`) writes its verdict to the
 * file's `virusScanResult`. Until that verdict is a Success, the zip is served to no one but its
 * owner and moderators (`getFileForModelVersion`).
 *
 * Training Data never goes through the model-file AIR scan: that scan fetches the file through the
 * public download route, which refuses an unscanned zip.
 */

/** `metadata.scan` on the workflow: tells the webhook a clean result must have read files. */
export const TRAINING_DATA_BLOB_SCAN = 'training-data-blob';

/** For the zip's storage to answer; the copy itself is bounded by the upload deadline. */
const SOURCE_RESPONSE_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const SUBMIT_TIMEOUT_MS = 60_000;

export type TrainingDataScanTarget = {
  fileId: number;
  modelVersionId: number;
  /** The file's stored url, as the resolver knows it. */
  url: string;
};

/**
 * Submits one Training Data file to the scan. Throws when it could not be submitted; the file stays
 * Pending. Outside production without an orchestrator token nothing is submitted and the file stays
 * Pending: a scan is never faked.
 */
export async function submitTrainingDataScan({
  fileId,
  modelVersionId,
  url,
}: TrainingDataScanTarget) {
  if (!isProd && !env.ORCHESTRATOR_ACCESS_TOKEN) return;

  await dbWrite.modelFile.update({
    where: { id: fileId },
    data: { scanRequestedAt: new Date() },
  });

  const { url: sourceUrl } = await resolveDownloadUrl(fileId, url, undefined, {
    caller: 'training-data',
    actor: 'internal',
  });
  const answered = new AbortController();
  const noAnswer = setTimeout(() => answered.abort(), SOURCE_RESPONSE_TIMEOUT_MS);
  const source = await fetch(sourceUrl, {
    signal: AbortSignal.any([answered.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
  }).finally(() => clearTimeout(noAnswer));
  let blobId: string;
  try {
    const size = Number(source.headers.get('content-length'));
    if (!source.ok || !source.body || !(size > 0))
      throw new Error(`Training data source unreadable: ${source.status}`);
    blobId = await uploadConsumerBlob({ body: source.body, size, timeoutMs: UPLOAD_TIMEOUT_MS });
  } catch (error) {
    // Releases the connection now rather than at the deadline.
    await source.body?.cancel().catch(() => undefined);
    throw error;
  }
  const air = blobAir(blobId);
  // The url ties the verdict to these bytes: the webhook drops it once the file holds another zip.
  const metadata = { fileId, modelVersionId, url, scan: TRAINING_DATA_BLOB_SCAN };
  const { data } = await submitWorkflow({
    client: internalOrchestratorClient,
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    body: {
      metadata,
      currencies: [],
      tags: ['civitai', 'training-data-scan'],
      steps: [
        {
          $type: 'modelClamScan',
          name: 'clamScan',
          metadata,
          input: { model: air },
        } as WorkflowStepTemplate,
      ],
      callbacks: [
        {
          url: `${env.NEXTAUTH_URL}/api/webhooks/model-file-scan-result?token=${env.WEBHOOK_TOKEN}`,
          type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
        },
      ],
    },
  });
  if (!data?.id) throw new Error(`Training data scan was not accepted for file ${fileId}`);
}

/** As `submitTrainingDataScan`, for a caller that must not fail on it: the failure is logged. */
export async function submitTrainingDataScanSafe(
  target: TrainingDataScanTarget,
  op: string
): Promise<boolean> {
  try {
    await submitTrainingDataScan(target);
    return true;
  } catch (error) {
    logToAxiom({
      ...safeError(error),
      type: 'error',
      name: 'training-data-scan-submit',
      op,
      fileId: target.fileId,
      modelVersionId: target.modelVersionId,
    }).catch(() => undefined);
    return false;
  }
}

/**
 * A Training Data zip still waiting for a verdict, on a model that is still up. A Studio placeholder
 * (0 bytes) has no zip yet.
 */
const pendingTrainingDataWhere: Prisma.ModelFileWhereInput = {
  type: 'Training Data',
  virusScanResult: ScanResultCode.Pending,
  sizeKB: { gt: 0 },
  OR: [{ exists: null }, { exists: true }],
  modelVersion: {
    model: {
      deletedAt: null,
      tosViolation: false,
      status: { notIn: [ModelStatus.Deleted, ModelStatus.UnpublishedViolation] },
    },
  },
};

const REQUEUE_CONCURRENCY = 3;
/** A zip submitted this recently may still be copying or scanning. */
const REQUEUE_IN_FLIGHT_MS = 60 * 60_000;

/**
 * Submits one page of the Pending Training Data zips, oldest first, to the scan, skipping any
 * submitted within the last hour. With `dryRun` it submits nothing. `total` counts every Pending zip.
 */
export async function requeuePendingTrainingDataScans({
  limit,
  afterId,
  dryRun,
}: {
  limit: number;
  afterId?: number;
  dryRun: boolean;
}) {
  const where: Prisma.ModelFileWhereInput = {
    ...pendingTrainingDataWhere,
    AND: [
      {
        OR: [
          { scanRequestedAt: null },
          { scanRequestedAt: { lt: new Date(Date.now() - REQUEUE_IN_FLIGHT_MS) } },
        ],
      },
    ],
    ...(afterId !== undefined && { id: { gt: afterId } }),
  };
  const [total, files] = await Promise.all([
    dbWrite.modelFile.count({ where: pendingTrainingDataWhere }),
    dbWrite.modelFile.findMany({
      where,
      select: { id: true, url: true, modelVersionId: true },
      orderBy: { id: 'asc' },
      take: limit,
    }),
  ]);
  const nextAfterId = files.length === limit ? files[files.length - 1].id : null;
  if (dryRun) return { dryRun, total, page: files.length, nextAfterId };

  const { claimed, submitted, failed } = await claimAndSubmit(files, 'requeue', {
    neverSubmitted: true,
  });
  return { dryRun, total, page: claimed.length, submitted, failed, nextAfterId };
}

type PendingZip = { id: number; url: string; modelVersionId: number };

/**
 * Claimed up front, so a retried or overlapping run skips the rows this one will copy. A row never
 * submitted is claimed only with `neverSubmitted`. `onClaimed` may hold a row back from submission
 * by returning false.
 */
async function claimAndSubmit(
  files: PendingZip[],
  op: string,
  {
    neverSubmitted,
    onClaimed = async () => true,
    onSubmitted = async () => undefined,
  }: {
    neverSubmitted: boolean;
    onClaimed?: (file: PendingZip) => Promise<boolean>;
    onSubmitted?: (file: PendingZip) => Promise<void>;
  }
) {
  const claimedIds = new Set(
    (
      await dbWrite.$queryRaw<{ id: number }[]>`
        UPDATE "ModelFile" SET "scanRequestedAt" = now()
        WHERE id = ANY(${files.map((file) => file.id)}::int[])
          AND ("scanRequestedAt" < now() - ${REQUEUE_IN_FLIGHT_MS / 1000} * interval '1 second'
            OR (${neverSubmitted}::boolean AND "scanRequestedAt" IS NULL))
        RETURNING id`
    ).map(({ id }) => id)
  );
  const claimed = files.filter((file) => claimedIds.has(file.id));

  let submitted = 0;
  const failed: number[] = [];
  await limitConcurrency(
    claimed.map((file) => async () => {
      if (!(await onClaimed(file))) return;
      const ok = await submitTrainingDataScanSafe(
        { fileId: file.id, modelVersionId: file.modelVersionId, url: file.url },
        op
      );
      if (ok) {
        submitted++;
        await onSubmitted(file);
      } else failed.push(file.id);
    }),
    REQUEUE_CONCURRENCY
  );
  return { claimed, submitted, failed };
}

/** Two waves at the copy concurrency, so a run ends well inside its lock. */
export const HEAL_PAGE = 6;
/** Accepted resubmits after the first submit before the zip is given up on. */
const HEAL_MAX_RESUBMITS = 3;
const HEAL_ATTEMPTS_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Per zip, not per file: a file that now holds another zip starts again. */
const healAttemptsKey = (file: PendingZip) =>
  `${REDIS_SYS_KEYS.TRAINING_DATA_SCAN.HEAL_ATTEMPTS}:${file.id}:${createHash('sha1')
    .update(file.url)
    .digest('hex')
    .slice(0, 16)}` as const;

/**
 * Resubmits Training Data zips that were submitted over an hour ago and still have no verdict,
 * oldest first. A zip that was never submitted is left to the upload paths and the mod requeue.
 * Only a resubmit the orchestrator accepted counts: one that failed (an outage) leaves the zip for the
 * next run. A zip still without a verdict after `HEAL_MAX_RESUBMITS` accepted resubmits is marked Error.
 */
export async function healStalledTrainingDataScans() {
  const files = await dbWrite.modelFile.findMany({
    where: {
      ...pendingTrainingDataWhere,
      scanRequestedAt: { not: null, lt: new Date(Date.now() - REQUEUE_IN_FLIGHT_MS) },
    },
    select: { id: true, url: true, modelVersionId: true },
    orderBy: { scanRequestedAt: 'asc' },
    take: HEAL_PAGE,
  });
  if (!files.length) return { picked: 0, submitted: 0, failed: [], gaveUp: [] };

  const gaveUp: number[] = [];
  const { claimed, submitted, failed } = await claimAndSubmit(files, 'self-heal', {
    neverSubmitted: false,
    onClaimed: async (file) => {
      let accepted: number;
      try {
        accepted = Number((await sysRedis.get(healAttemptsKey(file))) ?? 0);
      } catch {
        // Without a count the cap can't be kept; the next run tries again.
        return false;
      }
      if (accepted < HEAL_MAX_RESUBMITS) return true;

      await dbWrite.modelFile.updateMany({
        where: { id: file.id, url: file.url, virusScanResult: ScanResultCode.Pending },
        data: {
          virusScanResult: ScanResultCode.Error,
          virusScanMessage: 'The virus scan could not be completed.',
          scannedAt: new Date(),
        },
      });
      gaveUp.push(file.id);
      logToAxiom({
        type: 'error',
        name: 'training-data-scan-gave-up',
        fileId: file.id,
        reason: `no verdict after ${HEAL_MAX_RESUBMITS} resubmits`,
      }).catch(() => undefined);
      return false;
    },
    onSubmitted: async (file) => {
      const key = healAttemptsKey(file);
      try {
        await sysRedis.incrBy(key, 1);
        await sysRedis.expire(key, HEAL_ATTEMPTS_TTL_SECONDS);
      } catch {
        // An uncounted resubmit only allows one more.
      }
    },
  });
  if (failed.length)
    logToAxiom({
      type: 'warning',
      name: 'training-data-scan-heal-submit-failed',
      count: failed.length,
    }).catch(() => undefined);
  return { picked: claimed.length, submitted, failed, gaveUp };
}
