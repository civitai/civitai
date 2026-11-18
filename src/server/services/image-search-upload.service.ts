import { TRPCError } from '@trpc/server';
import { createHash, randomUUID } from 'crypto';
import type { NextApiRequest } from 'next';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import type { SearchUploadSource } from '~/server/schema/semantic-image-search.schema';
import { logToAxiom } from '~/server/logging/client';
import { countSearchUpload } from '~/server/metrics/semantic-search.metrics';
import { delIfValue } from '~/server/redis/atomic';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { uploadedSourceBlobId } from '~/server/services/blocks/block-generation-source.service';
import { readBlobState } from '~/server/services/orchestrator/blobRatings';
import { submitSearchUploadScan } from '~/server/services/orchestrator/orchestrator.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import {
  readSearchUploadScan,
  searchUploadFaceAnimeMin,
  searchUploadVerdict,
  type SearchUploadDecision,
  type SearchUploadRefusal,
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
/** Per user per day, moderators included: generous for case work, a ceiling on scan and embed spend. */
export const SEARCH_UPLOAD_USER_DAILY_LIMITS = { prepare: 100, search: 1000 } as const;
// Every viewer draws from one bucket: the rate-limit engine keys a bucket by user id.
const GLOBAL_BUCKET_USER = { id: 0 } as SessionUser;

/** What is kept of an upload: ids only, never the blob's URL. */
export type SearchUploadRecord = {
  userId: number;
  blobId: string;
  workflowId: string;
  createdAt: number;
  /** The site item the moderator started from. */
  source: SearchUploadSource;
  /** A hash of the URL that was scanned: the search must embed that same URL. */
  urlHash: string;
  /** The scan once it ended, so later pages do not read the workflow again. */
  scan?: Exclude<SearchUploadScan, { state: 'pending' }>;
  /** The blob's verdict once rated, so a later page's failed read cannot undo a pass. */
  blobBlockedReason?: string | null;
  /** The blob's verdict first came in after the timeout. */
  blobLate?: boolean;
};

const hashUrl = (url: string) => createHash('sha256').update(url).digest('hex');

const recordKey = (uploadId: string) =>
  `${REDIS_KEYS.CACHES.SEARCH_UPLOAD}:${uploadId}` as RedisKeyTemplateCache;
// Set apart from the record, and only once, so no save of an older copy of the record undoes it.
const refusedKey = (uploadId: string) =>
  `${REDIS_KEYS.CACHES.SEARCH_UPLOAD}:${uploadId}:refused` as RedisKeyTemplateCache;
const refKey = (userId: number, blobId: string, source: SearchUploadSource) =>
  `${REDIS_KEYS.CACHES.SEARCH_UPLOAD_REF}:${userId}:${blobId}:${source.kind}:${source.id}` as RedisKeyTemplateCache;
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

export const SEARCH_UPLOAD_SOURCE_MESSAGE = 'Search needs the site item you started from.';

/** Whether the item exists: a case is checked by its reference's format, as it lives in another app. */
async function sourceExists(source: SearchUploadSource) {
  const select = { id: true } as const;
  switch (source.kind) {
    case 'image':
      return !!(await dbRead.image.findUnique({ where: { id: source.id }, select }));
    case 'post':
      return !!(await dbRead.post.findUnique({ where: { id: source.id }, select }));
    case 'modelVersion':
      return !!(await dbRead.modelVersion.findUnique({ where: { id: source.id }, select }));
    case 'case':
      return true;
  }
}

/**
 * One of the viewer's daily uploads or search pages. Unlike the router's limits this counts
 * moderators, who are the feature's users; the scope is fail-closed, so an unreadable store refuses.
 */
export async function claimSearchUploadUserDay({
  userId,
  action,
  req,
}: {
  userId: number;
  action: keyof typeof SEARCH_UPLOAD_USER_DAILY_LIMITS;
  req: NextApiRequest;
}) {
  const record = await claimRateLimitAttempt({
    rules: [
      {
        limit: SEARCH_UPLOAD_USER_DAILY_LIMITS[action],
        period: 24 * 60 * 60,
        errorMessage: SEARCH_UPLOAD_CAPACITY_MESSAGE,
      },
    ],
    keyName: `imageSearchUpload:user-${action}`,
    scope: `imageSearchUpload.${action}`,
    // Only the id: the moderator exemption must not apply here.
    user: { id: userId } as SessionUser,
    req,
  });
  await record();
}

const searchingKey = (userId: number) =>
  `${REDIS_KEYS.CACHES.SEARCH_UPLOAD_SEARCHING}:${userId}` as RedisKeyTemplateCache;
const SEARCHING_HOLD_SECONDS = 60;

/**
 * Runs one of the viewer's upload searches at a time: the daily claim reads then writes its count,
 * so two at once would both pass it. The second is refused while the first runs.
 */
export async function withSearchUploadSearch<T>(userId: number, run: () => Promise<T>) {
  // Widened so the reply is read as SET's ('OK' | null), not as the token's template type.
  const token: string = randomUUID();
  const held = await redis.set(searchingKey(userId), token, {
    NX: true,
    EX: SEARCHING_HOLD_SECONDS,
  });
  if (held !== 'OK')
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'A search is already running.' });
  try {
    return await run();
  } finally {
    // A failed release must not replace the search's own result or refusal; the hold expires.
    try {
      // Only while this request still owns it: one that outlived its hold must not free the next's.
      await delIfValue(redis, searchingKey(userId), token);
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'search-upload-search-release',
        userId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Scans the uploaded consumer blob with the imageScanning step. Nothing is written to the database:
 * the upload is a cache record for an hour, and the orchestrator expires the blob. Returns at once;
 * the client polls {@link getSearchUploadStatus}.
 */
export async function prepareSearchUpload({
  userId,
  url,
  source,
  req,
}: {
  userId: number;
  url: string;
  source: SearchUploadSource | undefined;
  req: NextApiRequest;
}) {
  if (!source || !(await sourceExists(source)))
    throw new TRPCError({ code: 'BAD_REQUEST', message: SEARCH_UPLOAD_SOURCE_MESSAGE });
  const blobId = uploadedSourceBlobId(url);
  if (!blobId)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is not an uploaded image.' });

  const existing = await redis.packed.get<string>(refKey(userId, blobId, source));
  if (existing && (await redis.packed.get<SearchUploadRecord>(recordKey(existing))))
    return { uploadId: existing };
  const uploadId = randomUUID();
  // The scan timeout runs from before the submit, so a slow submit cannot stretch it.
  const createdAt = Date.now();
  // Taken atomically before the slot and the scan, so two uploads at once cannot both pass.
  const busy = await redis.set(pendingKey(userId), uploadId, {
    NX: true,
    EX: Math.ceil(SEARCH_UPLOAD_SCAN_TIMEOUT_MS / 1000),
  });
  if (busy === null)
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: SEARCH_UPLOAD_BUSY_MESSAGE });

  let workflowId: string | undefined;
  try {
    await claimSearchUploadUserDay({ userId, action: 'prepare', req });
    await claimSearchUploadSlot(req);
    workflowId = await submitSearchUploadScan({ blobUrl: url });
  } finally {
    if (!workflowId) await redis.del(pendingKey(userId));
  }
  if (!workflowId)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: SEARCH_UPLOAD_CAPACITY_MESSAGE });

  const record: SearchUploadRecord = {
    userId,
    blobId,
    workflowId,
    createdAt,
    source: { kind: source.kind, id: source.id } as SearchUploadSource,
    urlHash: hashUrl(url),
  };
  const ttl = secondsLeft(record.createdAt);
  await Promise.all([
    redis.packed.set(recordKey(uploadId), record, { EX: ttl }),
    redis.packed.set(refKey(userId, blobId, source), uploadId, { EX: ttl }),
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

const saveRecord = (uploadId: string, record: SearchUploadRecord) =>
  redis.packed.set(recordKey(uploadId), record, { EX: secondsLeft(record.createdAt) });

/** Frees the viewer for a new upload, unless a newer upload already holds the key. */
async function releaseBusy(uploadId: string, userId: number) {
  if ((await redis.get(pendingKey(userId))) === uploadId) await redis.del(pendingKey(userId));
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
    record.scan = scan;
    await Promise.all([saveRecord(uploadId, record), releaseBusy(uploadId, record.userId)]);
  }
  return scan;
}

/** The blob's verdict, read until it is rated and then kept on the record. */
async function blobFor(uploadId: string, record: SearchUploadRecord) {
  if (record.blobBlockedReason !== undefined)
    return { verdict: 'rated' as const, blockedReason: record.blobBlockedReason };
  const blob = await readBlobState(record.blobId);
  if (blob.verdict !== 'rated') return { verdict: 'pending' as const };
  record.blobBlockedReason = blob.blockedReason;
  record.blobLate = Date.now() - record.createdAt > SEARCH_UPLOAD_SCAN_TIMEOUT_MS;
  await saveRecord(uploadId, record);
  return { verdict: 'rated' as const, blockedReason: blob.blockedReason };
}

/** A scan that finished past the timeout is refused like one that never answered. */
const finishedLate = (scan: SearchUploadScan, createdAt: number) =>
  scan.state === 'done' &&
  !(scan.completedAt && Date.parse(scan.completedAt) - createdAt <= SEARCH_UPLOAD_SCAN_TIMEOUT_MS);

async function decide(uploadId: string, record: SearchUploadRecord, isModerator: boolean) {
  const kept = await redis.packed.get<SearchUploadRefusal>(refusedKey(uploadId));
  if (kept) return { scan: record.scan, decision: { verdict: 'refused' as const, reason: kept } };
  const scan = await scanFor(uploadId, record);
  const blob =
    scan.state === 'done' ? await blobFor(uploadId, record) : { verdict: 'pending' as const };
  const decision: SearchUploadDecision =
    finishedLate(scan, record.createdAt) || record.blobLate
      ? { verdict: 'refused', reason: 'timed-out' }
      : searchUploadVerdict(scan, blob, {
          isModerator,
          faceAnimeMin: searchUploadFaceAnimeMin(),
          timedOut: Date.now() - record.createdAt > SEARCH_UPLOAD_SCAN_TIMEOUT_MS,
        });
  if (decision.verdict === 'refused') {
    // The face rule depends on the viewer's moderator view; every other refusal is the image's.
    if (decision.reason !== 'faces')
      await redis.packed.set(refusedKey(uploadId), decision.reason, {
        EX: secondsLeft(record.createdAt),
        NX: true,
      });
    await releaseBusy(uploadId, record.userId);
    countSearchUpload('refused');
    logToAxiom({
      type: 'info',
      name: 'search-upload-refused',
      userId: record.userId,
      workflowId: record.workflowId,
      reason: decision.reason,
      payload: { sourceKind: record.source.kind, sourceId: String(record.source.id) },
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
  if (uploadedSourceBlobId(url) !== record.blobId || hashUrl(url) !== record.urlHash)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is not the uploaded image.' });
  const { scan, decision } = await decide(uploadId, record, isModerator);
  if (decision.verdict !== 'ready' || scan?.state !== 'done')
    throw new TRPCError({
      code: decision.verdict === 'pending' ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
      message:
        decision.verdict === 'pending'
          ? 'The image is still being checked.'
          : SEARCH_UPLOAD_REFUSED_MESSAGE,
    });
  return { nsfwLevel: scan.nsfwLevel, imageUrl: url };
}
