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
import { isDefiniteNotFound, resolveDownloadUrl } from '~/utils/delivery-worker';
import { ModelModifier, ModelStatus, ScanResultCode } from '~/shared/utils/prisma/enums';

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
const RECHECK_TIMEOUT_MS = 30_000;
const RESOLVE_TIMEOUT_MS = 30_000;

/** A definite answer that the zip can't be read: no object at the url, or one with no length or ETag. */
export class TrainingDataSourceUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrainingDataSourceUnreadable';
  }
}

/** The zip's download url. A lookup that does not answer in time is a transient failure. */
async function resolveSource(fileId: number, url: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { url: sourceUrl } = await Promise.race([
      resolveDownloadUrl(fileId, url, undefined, { caller: 'training-data', actor: 'internal' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Training data source lookup timed out')),
          RESOLVE_TIMEOUT_MS
        );
      }),
    ]);
    return sourceUrl;
  } catch (error) {
    if (isDefiniteNotFound(error))
      throw new TrainingDataSourceUnreadable('Training data source not found');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
export async function submitTrainingDataScan(
  { fileId, modelVersionId, url }: TrainingDataScanTarget,
  op?: string
) {
  if (!isProd && !env.ORCHESTRATOR_ACCESS_TOKEN) return false;

  await dbWrite.modelFile.update({
    where: { id: fileId },
    data: { scanRequestedAt: new Date() },
  });

  const sourceUrl = await resolveSource(fileId, url);
  const answered = new AbortController();
  const noAnswer = setTimeout(() => answered.abort(), SOURCE_RESPONSE_TIMEOUT_MS);
  const source = await fetch(sourceUrl, {
    signal: AbortSignal.any([answered.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
  }).finally(() => clearTimeout(noAnswer));
  let blobId: string;
  // What the verdict is checked against: the object must still be these bytes when it lands.
  const etag = source.headers.get('etag');
  const size = Number(source.headers.get('content-length'));
  try {
    if (!source.ok || !source.body)
      throw new Error(`Training data source unreadable: ${source.status}`);
    if (!(size > 0)) throw new TrainingDataSourceUnreadable('Training data source has no length');
    if (!etag) throw new TrainingDataSourceUnreadable('Training data source has no ETag');
    blobId = await uploadConsumerBlob({ body: source.body, size, timeoutMs: UPLOAD_TIMEOUT_MS });
  } catch (error) {
    // Releases the connection now rather than at the deadline.
    await source.body?.cancel().catch(() => undefined);
    throw error;
  }
  const air = blobAir(blobId);
  // The url ties the verdict to these bytes: the webhook drops it once the file holds another zip.
  const metadata = {
    fileId,
    modelVersionId,
    url,
    etag,
    size,
    scan: TRAINING_DATA_BLOB_SCAN,
    ...(op && { op }),
  };
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
  return true;
}

/**
 * Whether the object at `url` is still the one a scan copied: the same ETag and length. False when
 * either is missing or the check itself fails, so a verdict that can't be confirmed is never kept.
 */
export async function trainingDataObjectUnchanged({
  fileId,
  url,
  etag,
  size,
}: {
  fileId: number;
  url: string;
  etag?: unknown;
  size?: unknown;
}): Promise<boolean> {
  if (typeof etag !== 'string' || !etag || typeof size !== 'number' || !(size > 0)) return false;
  try {
    const sourceUrl = await resolveSource(fileId, url);
    const res = await fetch(sourceUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(RECHECK_TIMEOUT_MS),
    });
    try {
      const total =
        res.status === 206
          ? Number(res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1])
          : res.status === 200
          ? Number(res.headers.get('content-length'))
          : NaN;
      return res.headers.get('etag') === etag && total === size;
    } finally {
      await res.body?.cancel().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

type SubmitOutcome = 'submitted' | 'skipped' | 'unreadable' | 'failed';

/**
 * As `submitTrainingDataScan`, for a caller that must not fail on it. A failure is logged, except an
 * unreadable source under `quietUnreadable`, whose caller logs it once.
 */
async function submitTrainingDataScanOutcome(
  target: TrainingDataScanTarget,
  op: string,
  { quietUnreadable = false } = {}
): Promise<SubmitOutcome> {
  try {
    return (await submitTrainingDataScan(target, op)) ? 'submitted' : 'skipped';
  } catch (error) {
    const unreadable = error instanceof TrainingDataSourceUnreadable;
    if (unreadable && quietUnreadable) return 'unreadable';
    logToAxiom({
      ...safeError(error),
      type: 'error',
      name: 'training-data-scan-submit',
      op,
      fileId: target.fileId,
      modelVersionId: target.modelVersionId,
    }).catch(() => undefined);
    return unreadable ? 'unreadable' : 'failed';
  }
}

/** Whether the scan was submitted; a failure is logged instead of thrown. */
export async function submitTrainingDataScanSafe(target: TrainingDataScanTarget, op: string) {
  return (await submitTrainingDataScanOutcome(target, op)) === 'submitted';
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
      // `mode` is nullable, and `not` alone would skip every model without one.
      OR: [{ mode: null }, { mode: { not: ModelModifier.TakenDown } }],
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
    quietUnreadable = false,
  }: {
    neverSubmitted: boolean;
    onClaimed?: (file: PendingZip) => Promise<boolean>;
    onSubmitted?: (file: PendingZip, outcome: SubmitOutcome) => Promise<void>;
    quietUnreadable?: boolean;
  }
) {
  const claimedIds = new Set(
    (
      await dbWrite.$queryRaw<{ id: number }[]>`
        UPDATE "ModelFile" SET "scanRequestedAt" = now()
        WHERE id = ANY(${files.map((file) => file.id)}::int[])
          AND "type" = 'Training Data'
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
      const outcome = await submitTrainingDataScanOutcome(
        { fileId: file.id, modelVersionId: file.modelVersionId, url: file.url },
        op,
        { quietUnreadable }
      );
      if (outcome === 'submitted') submitted++;
      else failed.push(file.id);
      await onSubmitted(file, outcome);
    }),
    REQUEUE_CONCURRENCY
  );
  return { claimed, submitted, failed };
}

/** Two waves at the copy concurrency. */
export const HEAL_PAGE = 6;
/** Accepted resubmits after the first submit before the zip is given up on. */
const HEAL_MAX_RESUBMITS = 3;
const HEAL_ATTEMPTS_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * Definite "can't read the zip" answers before it is given up on, counting a clean verdict that could
 * not be confirmed against the object. A transient submit failure never counts.
 */
const HEAL_MAX_UNREADABLE = 24;

/** Per zip, not per file: a file that now holds another zip starts again. */
const zipKey = <Prefix extends string>(prefix: Prefix, file: PendingZip) =>
  `${prefix}:${file.id}:${createHash('sha1').update(file.url).digest('hex').slice(0, 16)}` as const;
const healAttemptsKey = (file: PendingZip) =>
  zipKey(REDIS_SYS_KEYS.TRAINING_DATA_SCAN.HEAL_ATTEMPTS, file);
const healUnreadableKey = (file: PendingZip) =>
  zipKey(REDIS_SYS_KEYS.TRAINING_DATA_SCAN.HEAL_UNREADABLE, file);

export const HEAL_OP = 'self-heal';

/**
 * Moves a self-heal resubmit whose clean verdict could not be confirmed against the object off the
 * resubmit count and onto the unreadable one: it was answered, but by an object that doesn't hold
 * still. Once per workflow, so a callback delivered twice is counted once.
 */
export async function uncountUnconfirmedResubmit({
  fileId,
  url,
  workflowId,
}: {
  fileId: number;
  url: string;
  workflowId: string;
}) {
  const zip = { id: fileId, url, modelVersionId: 0 };
  const once = `${REDIS_SYS_KEYS.TRAINING_DATA_SCAN.HEAL_TAKEN_BACK}:${workflowId}` as const;
  try {
    if ((await sysRedis.incrBy(once, 1)) !== 1) return;
    await sysRedis.expire(once, HEAL_ATTEMPTS_TTL_SECONDS);
    const accepted = healAttemptsKey(zip);
    if ((await sysRedis.decrBy(accepted, 1)) < 0) await sysRedis.incrBy(accepted, 1);
    const unreadable = healUnreadableKey(zip);
    await sysRedis.incrBy(unreadable, 1);
    await sysRedis.expire(unreadable, HEAL_ATTEMPTS_TTL_SECONDS);
  } catch {
    // An uncounted take-back only brings the give-up one resubmit nearer.
  }
}

/**
 * Resubmits Training Data zips that were submitted over an hour ago and still have no verdict,
 * oldest first. A zip that was never submitted is left to the upload paths and the mod requeue.
 * A zip is marked Error after `HEAL_MAX_RESUBMITS` accepted resubmits without a verdict, or after
 * `HEAL_MAX_UNREADABLE` definite answers that it can't be read. Any other failed resubmit (an outage)
 * is not counted: the zip comes back once its claim is an hour old.
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
  let unreadableRuns = 0;
  const { claimed, submitted, failed } = await claimAndSubmit(files, HEAL_OP, {
    neverSubmitted: false,
    quietUnreadable: true,
    onClaimed: async (file) => {
      let accepted: number;
      let unreadable: number;
      try {
        accepted = Number((await sysRedis.get(healAttemptsKey(file))) ?? 0);
        unreadable = Number((await sysRedis.get(healUnreadableKey(file))) ?? 0);
      } catch {
        // Without a count the cap can't be kept; it is tried again once its claim is an hour old.
        return false;
      }
      const reason =
        accepted >= HEAL_MAX_RESUBMITS
          ? `no verdict after ${HEAL_MAX_RESUBMITS} resubmits`
          : unreadable >= HEAL_MAX_UNREADABLE
          ? `source unreadable ${HEAL_MAX_UNREADABLE} times`
          : undefined;
      if (!reason) return true;

      await dbWrite.modelFile.updateMany({
        where: {
          id: file.id,
          url: file.url,
          type: 'Training Data',
          virusScanResult: ScanResultCode.Pending,
        },
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
        reason,
      }).catch(() => undefined);
      return false;
    },
    onSubmitted: async (file, outcome) => {
      const key =
        outcome === 'submitted'
          ? healAttemptsKey(file)
          : outcome === 'unreadable'
          ? healUnreadableKey(file)
          : undefined;
      if (!key) return;
      if (outcome === 'unreadable') unreadableRuns++;
      try {
        await sysRedis.incrBy(key, 1);
        await sysRedis.expire(key, HEAL_ATTEMPTS_TTL_SECONDS);
      } catch {
        // An uncounted resubmit only allows one more.
      }
    },
  });
  // Unreadable zips are logged once, when they are given up on.
  if (failed.length > unreadableRuns)
    logToAxiom({
      type: 'warning',
      name: 'training-data-scan-heal-submit-failed',
      count: failed.length - unreadableRuns,
    }).catch(() => undefined);
  return { picked: claimed.length, submitted, failed, gaveUp };
}
