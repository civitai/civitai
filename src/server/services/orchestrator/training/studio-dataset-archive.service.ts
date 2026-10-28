import { Upload } from '@aws-sdk/lib-storage';
import type { Prisma } from '@prisma/client';
import type { Workflow } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import archiver from 'archiver';
import { PassThrough, pipeline } from 'stream';
import { env } from '~/env/server';
import { UploadType } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import {
  createBoundedArchive,
  deriveUploadPartGeometry,
  ESTIMATED_BYTES_PER_ARCHIVED_IMAGE,
  MEDIA_ARCHIVE_COMPRESSION_LEVEL,
} from '~/server/utils/archive-helpers';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';
import { bytesToKB } from '~/utils/number-helpers';
import { getGetUrlByKey, getUploadBucket, getUploadS3Client } from '~/utils/s3-utils';
import { registerFileLocation } from '~/utils/storage-resolver';
import { buildUploadKey } from '~/utils/upload-key';

/**
 * A Training Studio run trains on orchestrator blobs, never a zip, so publishing it creates a
 * 0-byte `Training Data` row (see `createDraftModelFromWorkflow`). This turns that row into the
 * run's real dataset: every blob plus a same-named `.txt` caption — the layout the Studio's own
 * dataset download and "Import .zip" use — stored where the in-app trainer stores its zips.
 *
 * The blobs live only as long as the workflow does, so this runs soon after publish; a row whose
 * workflow is already gone is marked `unavailable` and keeps its placeholder.
 */

export const STUDIO_DATASET_MAX_ATTEMPTS = 3;
const BLOB_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
// Entries are whole buffered blobs (a source stream that errors stalls the archiver silently — see
// archive-helpers), so this is what bounds the blobs held in memory at once.
const MAX_PENDING_ENTRIES = 2;
const MAX_UPLOAD_QUEUE_SIZE = 2;

export type StudioDatasetArchive =
  | { status: 'archived'; items: number; skipped: number; at: string }
  | { status: 'unavailable'; reason: string; at: string };

type FileMetadata = Record<string, unknown> & {
  datasetArchiveAttempts?: number;
  /** A closed owner's row is never given up on, so its failures back off instead. ISO time. */
  datasetArchiveRetryAfter?: string;
  datasetArchiveServiceAttempts?: number;
  datasetArchive?: StudioDatasetArchive;
};

/**
 * Placeholders still waiting for their dataset, newest first: the newest workflows are the ones
 * whose blobs are surest to still exist. All but the last condition are the partial index
 * `ModelFile_studio_dataset_pending_idx` verbatim, so the query stays an index read once the
 * backlog is empty; the last skips rows backing off after a failed service-token read.
 */
export async function getPendingStudioDatasetFileIds(limit: number): Promise<number[]> {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "ModelFile"
    WHERE type = 'Training Data'
      AND "sizeKB" = 0
      AND metadata ? 'selectedEpochUrl'
      AND NOT metadata ? 'datasetArchive'
      AND (
        NOT metadata ? 'datasetArchiveRetryAfter'
        OR (metadata->>'datasetArchiveRetryAfter')::timestamptz < now()
      )
    ORDER BY id DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

type DatasetItem = { air: string; caption: string };

/** The blob list the run trained on, or null for a run whose data isn't blob-backed. */
export function getStudioDatasetItems(workflow: Workflow): DatasetItem[] | null {
  const steps = (workflow.steps ?? []) as { input?: { trainingData?: unknown } }[];
  const trainingData = steps.find((step) => step.input?.trainingData)?.input?.trainingData as
    | { type?: string; items?: { air?: unknown; caption?: unknown }[] }
    | undefined;
  if (trainingData?.type !== 'blobs' || !Array.isArray(trainingData.items)) return null;
  return trainingData.items
    .filter((item): item is { air: string; caption?: unknown } => typeof item?.air === 'string')
    .map((item) => ({
      air: item.air,
      caption: typeof item.caption === 'string' ? item.caption : '',
    }));
}

/** The orchestrator's blob key in each stored form of a dataset `air` (mirrors the Studio's
 *  `blobIdFromAir`): a consumer-blob URL, an AIR URN (`…blob@<key>`), or a bare key. */
export function blobKeyFromAir(air: string): string {
  const marker = '/v2/consumer/blobs/';
  const idx = air.indexOf(marker);
  if (idx >= 0) return air.slice(idx + marker.length).split('?')[0];
  if (air.startsWith('urn:air:')) return (air.split('@').pop() ?? air).split('?')[0];
  return air.split('?')[0];
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
};

function extensionFor(key: string, contentType: string | null): string {
  const fromKey = key.includes('.') ? key.split('.').pop() : undefined;
  if (fromKey && /^[a-z0-9]{1,5}$/i.test(fromKey)) return fromKey.toLowerCase();
  const mime = contentType?.split(';')[0].trim().toLowerCase();
  return (mime && EXT_BY_MIME[mime]) || 'bin';
}

async function fetchBlob({
  baseUrl,
  token,
  air,
  workflowId,
}: {
  baseUrl: string;
  token: string;
  air: string;
  workflowId: string;
}): Promise<{ bytes: Buffer; key: string; contentType: string | null } | null> {
  const key = blobKeyFromAir(air);
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/v2/consumer/blobs/${encodeURIComponent(
        key
      )}?workflowId=${encodeURIComponent(workflowId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS),
      }
    );
    if (!response.ok) return null;
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      key,
      contentType: response.headers.get('content-type'),
    };
  } catch {
    return null;
  }
}

/** Zips `items` straight into object storage. Throws when no blob could be fetched, so an empty
 *  zip is never stored. */
async function uploadDatasetZip({
  items,
  baseUrl,
  token,
  workflowId,
  key,
}: {
  items: DatasetItem[];
  baseUrl: string;
  token: string;
  workflowId: string;
  key: string;
}) {
  const useB2 = !!env.S3_UPLOAD_B2_ENDPOINT;
  const s3 = getUploadS3Client(useB2 ? 'b2' : 'default');
  const bucket = getUploadBucket(useB2 ? 'b2' : 'default');

  const archive = archiver('zip', { zlib: { level: MEDIA_ARCHIVE_COMPRESSION_LEVEL } });
  const body = new PassThrough();
  // `pipeline`, not `.pipe()`: a failed upload destroys `body`, and only `pipeline` carries that
  // back to the archiver so the appends below fail instead of hanging.
  pipeline(archive, body, () => undefined);
  const bounded = createBoundedArchive({
    archive,
    output: body,
    maxPendingEntries: MAX_PENDING_ENTRIES,
  });

  const { partSize, queueSize } = deriveUploadPartGeometry({
    expectedBytes: items.length * ESTIMATED_BYTES_PER_ARCHIVED_IMAGE,
  });
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: body, ContentType: 'application/zip' },
    partSize,
    queueSize: Math.min(queueSize, MAX_UPLOAD_QUEUE_SIZE),
    leavePartsOnError: false,
  });
  // Started before the first append: nothing drains `body` otherwise, and the archiver stalls.
  let uploadError: unknown;
  const uploaded = upload.done().then(
    () => true,
    (e: unknown) => {
      uploadError = e;
      body.destroy(e instanceof Error ? e : new Error(String(e)));
      return false;
    }
  );

  const pad = Math.max(2, String(items.length).length);
  let included = 0;
  let captions = 0;
  try {
    for (const [index, item] of items.entries()) {
      const blob = await fetchBlob({ baseUrl, token, air: item.air, workflowId });
      if (!blob) continue;
      const base = String(index + 1).padStart(pad, '0');
      await bounded.append(blob.bytes, {
        name: `${base}.${extensionFor(blob.key, blob.contentType)}`,
      });
      included += 1;
      const caption = item.caption.trim();
      if (caption) {
        await bounded.append(Buffer.from(caption, 'utf8'), { name: `${base}.txt` });
        captions += 1;
      }
    }
    if (included === 0) throw new Error('none of the dataset blobs could be fetched');
    await bounded.finalize();
  } catch (e) {
    archive.abort();
    await upload.abort().catch(() => undefined);
    body.destroy();
    await uploaded;
    throw uploadError ?? e;
  }

  if (!(await uploaded)) throw uploadError;
  const { url } = await getGetUrlByKey(key, { s3, bucket });
  return {
    url: url.split('?')[0],
    bytes: archive.pointer(),
    included,
    captions,
    skipped: items.length - included,
    backend: useB2 ? ('backblaze' as const) : ('cloudflare' as const),
  };
}

export type StudioDatasetArchiveResult =
  | { fileId: number; outcome: 'archived'; items: number; skipped: number }
  | { fileId: number; outcome: 'unavailable'; reason: string }
  | { fileId: number; outcome: 'retry'; attempts: number; error: string }
  | { fileId: number; outcome: 'skipped' };

/**
 * Archives one placeholder's dataset. Never throws: a transient failure is counted and retried by a
 * later run, up to `STUDIO_DATASET_MAX_ATTEMPTS`, after which the row is marked `unavailable`.
 */
export async function archiveStudioDataset(fileId: number): Promise<StudioDatasetArchiveResult> {
  const file = await dbWrite.modelFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      sizeKB: true,
      metadata: true,
      modelVersionId: true,
      modelVersion: {
        select: {
          model: {
            select: {
              id: true,
              userId: true,
              meta: true,
              user: { select: { bannedAt: true, deletedAt: true } },
            },
          },
        },
      },
    },
  });
  const metadata = (file?.metadata ?? {}) as FileMetadata;
  // Claimed by nobody else in the meantime: the job's lock keeps runs from overlapping, and a row
  // the owner replaced with a real file is no longer a placeholder.
  if (!file || file.sizeKB !== 0 || metadata.datasetArchive) return { fileId, outcome: 'skipped' };

  const { model } = file.modelVersion;
  const markUnavailable = async (reason: string): Promise<StudioDatasetArchiveResult> => {
    await writeMetadata(file.id, {
      ...metadata,
      datasetArchive: { status: 'unavailable', reason, at: new Date().toISOString() },
    });
    return { fileId, outcome: 'unavailable', reason };
  };

  const workflowId = (model.meta as { trainingStudioWorkflowId?: string } | null)
    ?.trainingStudioWorkflowId;
  if (!workflowId) return markUnavailable('not a Training Studio model');

  // A banned or deleted owner cannot be minted a token, so their run is read with the service token.
  const ownerClosed = !!(model.user.bannedAt || model.user.deletedAt);
  try {
    const token = ownerClosed ? serviceToken() : await getOrchestratorToken(model.userId);
    let workflow: Workflow;
    try {
      workflow = await getWorkflow({ token, path: { workflowId } });
    } catch (error) {
      // Under the service token a not-found is not proof the run is gone: it fails safe below.
      if (error instanceof TRPCError && error.code === 'NOT_FOUND' && !ownerClosed)
        return markUnavailable('workflow no longer exists');
      throw error;
    }
    const items = getStudioDatasetItems(workflow);
    if (!items?.length) {
      if (ownerClosed) throw new Error('run read with the service token has no blob dataset');
      return markUnavailable('run has no blob dataset');
    }

    const { baseUrl } = createOrchestratorClient(token).getConfig();
    if (!baseUrl) throw new Error('orchestrator endpoint is not configured');

    const key = buildUploadKey(
      UploadType.TrainingImages,
      model.userId,
      `${file.modelVersionId}_training_data.zip`
    );
    const stored = await uploadDatasetZip({ items, baseUrl, token, workflowId, key });
    const sizeKB = bytesToKB(stored.bytes);
    const archived: StudioDatasetArchive = {
      status: 'archived',
      items: stored.included,
      skipped: stored.skipped,
      at: new Date().toISOString(),
    };

    // Conditional on the row still being the placeholder, so a file the owner swapped in while this
    // ran is not overwritten (the zip it built is then orphaned, which is the cheaper failure).
    const { count } = await dbWrite.modelFile.updateMany({
      where: { id: file.id, sizeKB: 0 },
      data: {
        url: stored.url,
        sizeKB,
        exists: true,
        // A dataset is never public by default — the in-app trainer only shares one the owner
        // opted into. This also closes the placeholders created Public before 2026-10-13.
        visibility: ModelFileVisibility.Private,
        metadata: {
          ...metadata,
          numImages: stored.included,
          numCaptions: stored.captions,
          datasetArchive: archived,
        },
      },
    });
    if (count === 0) return { fileId, outcome: 'skipped' };

    await deleteFilesForModelVersionCache(file.modelVersionId);
    await registerFileLocation({
      fileId: file.id,
      modelVersionId: file.modelVersionId,
      modelId: model.id,
      backend: stored.backend,
      path: key,
      sizeKb: sizeKB,
    }).catch((error) =>
      logToAxiom({
        type: 'error',
        ...safeError(error),
        name: 'register-file-location-failed',
        op: 'studio-dataset-archive',
        fileId: file.id,
      }).catch(() => undefined)
    );
    return { fileId, outcome: 'archived', items: stored.included, skipped: stored.skipped };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ownerClosed) {
      // Never given up on: the owner can no longer re-upload, so this copy may be the only one left.
      const serviceAttempts = (metadata.datasetArchiveServiceAttempts ?? 0) + 1;
      await logToAxiom({
        type: 'error',
        name: 'studio-dataset-archive-service-read-failed',
        fileId,
        modelVersionId: file.modelVersionId,
        attempts: serviceAttempts,
        message,
      }).catch(() => undefined);
      const retryAfter = new Date(Date.now() + serviceRetryDelayMs(serviceAttempts));
      await writeMetadata(file.id, {
        ...metadata,
        datasetArchiveServiceAttempts: serviceAttempts,
        datasetArchiveRetryAfter: retryAfter.toISOString(),
      });
      return { fileId, outcome: 'retry', attempts: serviceAttempts, error: message };
    }
    // A ban landing mid-run refuses the owner's mint: the next run takes the service-token path.
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
      const attempts = metadata.datasetArchiveAttempts ?? 0;
      return { fileId, outcome: 'retry', attempts, error: message };
    }
    const attempts = (metadata.datasetArchiveAttempts ?? 0) + 1;
    if (attempts >= STUDIO_DATASET_MAX_ATTEMPTS) return markUnavailable(`failed: ${message}`);
    await writeMetadata(file.id, { ...metadata, datasetArchiveAttempts: attempts });
    return { fileId, outcome: 'retry', attempts, error: message };
  }
}

const SERVICE_RETRY_BASE_MS = 60 * 60 * 1000;
const SERVICE_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
/** 1h, 2h, 4h ... capped at a day: still retried, without crowding newer rows out of a run. */
export function serviceRetryDelayMs(attempts: number) {
  return Math.min(SERVICE_RETRY_BASE_MS * 2 ** (attempts - 1), SERVICE_RETRY_MAX_MS);
}

function serviceToken() {
  if (!env.ORCHESTRATOR_ACCESS_TOKEN)
    throw new Error('no orchestrator service token is configured');
  return env.ORCHESTRATOR_ACCESS_TOKEN;
}

async function writeMetadata(fileId: number, metadata: FileMetadata) {
  await dbWrite.modelFile.update({
    where: { id: fileId },
    data: { metadata: metadata as Prisma.InputJsonObject },
  });
}
