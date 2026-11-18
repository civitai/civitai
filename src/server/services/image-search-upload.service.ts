import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import type { NextApiRequest } from 'next';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { countSearchUpload } from '~/server/metrics/semantic-search.metrics';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { uploadedSourceBlobId } from '~/server/services/blocks/block-generation-source.service';
import { readBlobState } from '~/server/services/orchestrator/blobRatings';
import { submitSearchUploadScan } from '~/server/services/orchestrator/orchestrator.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import {
  readSearchUploadScan,
  searchUploadFaceAnimeMin,
  searchUploadVerdict,
  type SearchUploadScan,
  type SearchUploadVerdict,
} from '~/server/services/search-upload-gate';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import type { SessionUser } from '~/types/session';

/** The only thing a refused upload's owner is told. */
export const SEARCH_UPLOAD_REFUSED_MESSAGE = "This image can't be used for search.";
export const SEARCH_UPLOAD_BUSY_MESSAGE =
  'Your last image is still being checked. Try again shortly.';
export const SEARCH_UPLOAD_CAPACITY_MESSAGE = 'Search by image is busy right now. Try again later.';

/** An upload can be searched from this long after it was prepared; the orchestrator expires the blob. */
export const SEARCH_UPLOAD_TTL_MS = 60 * 60 * 1000;
/** A scan with no answer by now is refused, never left pending. */
export const SEARCH_UPLOAD_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
export const SEARCH_UPLOAD_GLOBAL_DAILY_CAP = 5000;
// Every viewer draws from one bucket: the rate-limit engine keys a bucket by user id.
const GLOBAL_BUCKET_USER = { id: 0 } as SessionUser;

/** What is kept of an upload: ids only, never the blob's URL. */
export type SearchUploadRecord = {
  userId: number;
  blobId: string;
  workflowId: string;
  createdAt: number;
  /** The scan once it ended, so later pages do not read the workflow again. */
  scan?: Exclude<SearchUploadScan, { state: 'pending' }>;
};

const recordKey = (uploadId: string) =>
  `${REDIS_KEYS.CACHES.SEARCH_UPLOAD}:${uploadId}` as RedisKeyTemplateCache;
const refKey = (userId: number, blobId: string) =>
  `${REDIS_KEYS.CACHES.SEARCH_UPLOAD_REF}:${userId}:${blobId}` as RedisKeyTemplateCache;
const pendingKey = (userId: number) =>
  `${REDIS_KEYS.CACHES.SEARCH_UPLOAD_PENDING}:${userId}` as RedisKeyTemplateCache;

const secondsLeft = (createdAt: number) =>
  Math.max(1, Math.ceil((createdAt + SEARCH_UPLOAD_TTL_MS - Date.now()) / 1000));

/**
 * Takes one of the day's site-wide upload slots. The imageSearchUpload scope is fail-closed, so an
 * unreadable store refuses: this cap is what bounds scan and embed spend.
 */
export async function claimSearchUploadSlot(req: NextApiRequest) {
  const record = await claimRateLimitAttempt({
    rules: [
      {
        limit: SEARCH_UPLOAD_GLOBAL_DAILY_CAP,
        period: 24 * 60 * 60,
        errorMessage: SEARCH_UPLOAD_CAPACITY_MESSAGE,
      },
    ],
    keyName: 'imageSearchUpload:global',
    scope: 'imageSearchUpload.prepare',
    user: GLOBAL_BUCKET_USER,
    req,
  });
  await record();
}

/**
 * Scans the uploaded consumer blob with the imageScanning step. Nothing is written to the database:
 * the upload is a cache record for an hour, and the orchestrator expires the blob. Returns at once;
 * the client polls {@link getSearchUploadStatus}.
 */
export async function prepareSearchUpload({
  userId,
  url,
  req,
}: {
  userId: number;
  url: string;
  req: NextApiRequest;
}) {
  const blobId = uploadedSourceBlobId(url);
  if (!blobId)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is not an uploaded image.' });

  const existing = await redis.packed.get<string>(refKey(userId, blobId));
  if (existing && (await redis.packed.get<SearchUploadRecord>(recordKey(existing))))
    return { uploadId: existing };
  if (await redis.exists(pendingKey(userId)))
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: SEARCH_UPLOAD_BUSY_MESSAGE });
  await claimSearchUploadSlot(req);

  const workflowId = await submitSearchUploadScan({ blobUrl: url });
  if (!workflowId)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: SEARCH_UPLOAD_CAPACITY_MESSAGE });

  const uploadId = randomUUID();
  const record: SearchUploadRecord = { userId, blobId, workflowId, createdAt: Date.now() };
  const ttl = secondsLeft(record.createdAt);
  await Promise.all([
    redis.packed.set(recordKey(uploadId), record, { EX: ttl }),
    redis.packed.set(refKey(userId, blobId), uploadId, { EX: ttl }),
    redis.packed.set(pendingKey(userId), uploadId, {
      EX: Math.ceil(SEARCH_UPLOAD_SCAN_TIMEOUT_MS / 1000),
    }),
  ]);
  countSearchUpload('prepared');
  return { uploadId };
}

async function ownedUpload(userId: number, uploadId: string) {
  const record = await redis.packed.get<SearchUploadRecord>(recordKey(uploadId));
  if (!record || record.userId !== userId || Date.now() - record.createdAt > SEARCH_UPLOAD_TTL_MS)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Upload not found. Upload the image again.',
    });
  return record;
}

/** The scan's result, read from the workflow until it ends and then kept on the record. */
async function scanFor(uploadId: string, record: SearchUploadRecord): Promise<SearchUploadScan> {
  if (record.scan) return record.scan;
  const workflow = await getWorkflow({
    token: env.ORCHESTRATOR_ACCESS_TOKEN,
    path: { workflowId: record.workflowId },
  });
  const scan = readSearchUploadScan(workflow);
  if (scan.state !== 'pending') {
    await Promise.all([
      redis.packed.set(
        recordKey(uploadId),
        { ...record, scan },
        { EX: secondsLeft(record.createdAt) }
      ),
      redis.del(pendingKey(record.userId)),
    ]);
  }
  return scan;
}

async function decide(uploadId: string, record: SearchUploadRecord, isModerator: boolean) {
  const scan = await scanFor(uploadId, record);
  const blob =
    scan.state === 'done' ? await readBlobState(record.blobId) : { verdict: 'pending' as const };
  const decision = searchUploadVerdict(
    scan,
    blob.verdict === 'rated'
      ? { verdict: 'rated', blockedReason: blob.blockedReason }
      : { verdict: 'pending' },
    {
      isModerator,
      faceAnimeMin: searchUploadFaceAnimeMin(),
      timedOut: Date.now() - record.createdAt > SEARCH_UPLOAD_SCAN_TIMEOUT_MS,
    }
  );
  if (decision.verdict === 'refused') {
    countSearchUpload('refused');
    logToAxiom({
      type: 'info',
      name: 'search-upload-refused',
      userId: record.userId,
      workflowId: record.workflowId,
      reason: decision.reason,
    });
  }
  return { scan, decision };
}

export async function getSearchUploadStatus({
  userId,
  uploadId,
  isModerator,
}: {
  userId: number;
  uploadId: string;
  isModerator: boolean;
}): Promise<{ status: SearchUploadVerdict; message?: string }> {
  const record = await ownedUpload(userId, uploadId);
  const { decision } = await decide(uploadId, record, isModerator);
  if (decision.verdict === 'refused')
    return { status: 'refused', message: SEARCH_UPLOAD_REFUSED_MESSAGE };
  return { status: decision.verdict };
}

/** The image to search from: re-checked on every page. */
export async function resolveSearchUploadAnchor({
  userId,
  uploadId,
  url,
  isModerator,
}: {
  userId: number;
  uploadId: string;
  /** The blob's URL, sent again by the client: only the blob id is kept, so it must match. */
  url: string;
  isModerator: boolean;
}) {
  const record = await ownedUpload(userId, uploadId);
  if (uploadedSourceBlobId(url) !== record.blobId)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is not the uploaded image.' });
  const { scan, decision } = await decide(uploadId, record, isModerator);
  if (decision.verdict !== 'ready' || scan.state !== 'done')
    throw new TRPCError({
      code: decision.verdict === 'pending' ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
      message:
        decision.verdict === 'pending'
          ? 'The image is still being checked.'
          : SEARCH_UPLOAD_REFUSED_MESSAGE,
    });
  return { nsfwLevel: scan.nsfwLevel, imageUrl: url };
}
