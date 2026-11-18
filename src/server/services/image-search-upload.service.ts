import { TRPCError } from '@trpc/server';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { logToAxiom } from '~/server/logging/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import { countSearchUpload } from '~/server/metrics/semantic-search.metrics';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import {
  fitGenerationSourceBounds,
  stageGenerationOutputImage,
} from '~/server/services/blocks/block-image-upload.service';
import { uploadedSourceBlobId } from '~/server/services/blocks/block-generation-source.service';
import { readBlobState } from '~/server/services/orchestrator/blobRatings';
import {
  searchUploadFaceAnimeMin,
  searchUploadVerdict,
  type SearchUploadVerdict,
} from '~/server/services/search-upload-gate';
import {
  findOwnedSearchUpload,
  findSearchUploadByRef,
  hasUnscannedSearchUpload,
  SEARCH_UPLOAD_REF_META_KEY,
  type SearchUploadRecord,
} from '~/server/services/search-upload-rows';
import {
  SEARCH_UPLOAD_APP_ID,
  SEARCH_UPLOAD_APP_ID_META_KEY,
} from '~/shared/utils/block-provenance-metadata';

/** The only thing a refused upload's owner is told. */
export const SEARCH_UPLOAD_REFUSED_MESSAGE = "This image can't be used for search.";
export const SEARCH_UPLOAD_BUSY_MESSAGE =
  'Your last image is still being checked. Try again shortly.';
export const SEARCH_UPLOAD_CAPACITY_MESSAGE = 'Search by image is busy right now. Try again later.';

/** A passed upload is kept this long, so later pages can re-embed it, then swept. */
export const SEARCH_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const SEARCH_UPLOAD_GLOBAL_DAILY_CAP = 5000;
const SEARCH_UPLOAD_ALERT_AT = (SEARCH_UPLOAD_GLOBAL_DAILY_CAP * 4) / 5;
const SEARCH_UPLOAD_WRITE_BUDGET_MS = 30_000;
// An upload older than this that is still unscanned no longer blocks a new one.
const UNSCANNED_WINDOW_MS = 10 * 60 * 1000;

const dailyKey = (now: Date) =>
  `${REDIS_KEYS.SEMANTIC_SEARCH.UPLOADS_DAILY}:${now
    .toISOString()
    .slice(0, 10)}` as RedisKeyTemplateCache;

/**
 * Takes one of the day's site-wide upload slots. Fails closed: an unreadable store refuses, since
 * this cap is what bounds scan and embed spend when per-user limits are not enough.
 */
export async function claimSearchUploadSlot(now = new Date()) {
  let count: number;
  try {
    const key = dailyKey(now);
    count = await redis.incrBy(key, 1);
    if (count === 1) await redis.expire(key, 2 * 24 * 60 * 60);
  } catch (error) {
    logToAxiom({ type: 'error', name: 'search-upload-cap', message: (error as Error).message });
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: SEARCH_UPLOAD_CAPACITY_MESSAGE });
  }
  if (count === SEARCH_UPLOAD_ALERT_AT)
    logToAxiom({
      type: 'warning',
      name: 'search-upload-cap',
      message: 'daily cap 80% used',
      count,
    });
  if (count > SEARCH_UPLOAD_GLOBAL_DAILY_CAP)
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: SEARCH_UPLOAD_CAPACITY_MESSAGE });
}

/**
 * Copies the uploaded consumer blob into a private, unposted Image row that the normal ingestion
 * scans. Returns at once; the client polls {@link getSearchUploadStatus}.
 */
export async function prepareSearchUpload({ userId, url }: { userId: number; url: string }) {
  const blobId = uploadedSourceBlobId(url);
  if (!blobId)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is not an uploaded image.' });
  const ref = `upload:${blobId}`;
  const now = Date.now();

  const existing = await findSearchUploadByRef(userId, ref, new Date(now - SEARCH_UPLOAD_TTL_MS));
  if (existing) return { uploadId: existing };
  if (await hasUnscannedSearchUpload(userId, new Date(now - UNSCANNED_WINDOW_MS)))
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: SEARCH_UPLOAD_BUSY_MESSAGE });
  await claimSearchUploadSlot(new Date(now));

  const signal = fetchTimeoutSignal(SEARCH_UPLOAD_WRITE_BUDGET_MS);
  let measured: { width: number; height: number } | undefined;
  const staged = await stageGenerationOutputImage({
    imageUrl: url,
    width: null,
    height: null,
    source: 'search-upload',
    signal,
    transform: async (bytes) => {
      const fitted = await fitGenerationSourceBounds(bytes);
      measured = fitted.size;
      return fitted.bytes;
    },
  });
  if (!measured)
    throw new TRPCError({ code: 'BAD_REQUEST', message: SEARCH_UPLOAD_REFUSED_MESSAGE });

  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: staged.url,
    type: 'image',
    mimeType: staged.mimeType,
    hash: staged.hash,
    width: measured.width,
    height: measured.height,
    metadata: { ...staged.metadata, [SEARCH_UPLOAD_REF_META_KEY]: ref },
    blockProvenance: { key: SEARCH_UPLOAD_APP_ID_META_KEY, appId: SEARCH_UPLOAD_APP_ID },
    userId,
  });
  countSearchUpload('prepared');
  return { uploadId: image.id };
}

async function verdictFor(row: SearchUploadRecord, isModerator: boolean) {
  const ref = row.metadata?.[SEARCH_UPLOAD_REF_META_KEY];
  const blobId = typeof ref === 'string' && ref.startsWith('upload:') ? ref.slice(7) : undefined;
  if (!blobId) return 'refused' as const;
  const blob = await readBlobState(blobId);
  return searchUploadVerdict(
    row,
    blob.verdict === 'rated'
      ? { verdict: 'rated', blockedReason: blob.blockedReason }
      : { verdict: 'pending' },
    { isModerator, faceAnimeMin: searchUploadFaceAnimeMin() }
  );
}

async function ownedUpload(userId: number, uploadId: number) {
  const row = await findOwnedSearchUpload(userId, uploadId);
  if (!row || Date.now() - row.createdAt.getTime() > SEARCH_UPLOAD_TTL_MS)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Upload not found. Upload the image again.',
    });
  return row;
}

export async function getSearchUploadStatus({
  userId,
  uploadId,
  isModerator,
}: {
  userId: number;
  uploadId: number;
  isModerator: boolean;
}): Promise<{ status: SearchUploadVerdict; message?: string }> {
  const row = await ownedUpload(userId, uploadId);
  const status = await verdictFor(row, isModerator);
  if (status === 'refused') {
    countSearchUpload('refused');
    logToAxiom({ type: 'info', name: 'search-upload-refused', userId, imageId: row.id });
    return { status, message: SEARCH_UPLOAD_REFUSED_MESSAGE };
  }
  return { status };
}

/** The image to search from: re-checked on every page, so a row flagged after it passed stops. */
export async function resolveSearchUploadAnchor({
  userId,
  uploadId,
  isModerator,
}: {
  userId: number;
  uploadId: number;
  isModerator: boolean;
}) {
  const row = await ownedUpload(userId, uploadId);
  const status = await verdictFor(row, isModerator);
  if (status !== 'ready')
    throw new TRPCError({
      code: status === 'pending' ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
      message:
        status === 'pending' ? 'The image is still being checked.' : SEARCH_UPLOAD_REFUSED_MESSAGE,
    });
  return { nsfwLevel: row.nsfwLevel, imageUrl: searchUploadEmbedUrl(row.url) };
}

/** The variant the vector sync embeds indexed images from (event-engine `EMBED_IMAGE_PARAMS`). */
export function searchUploadEmbedUrl(key: string) {
  return getEdgeUrl(key, { anim: false, width: 800, optimized: true, type: 'image' });
}
