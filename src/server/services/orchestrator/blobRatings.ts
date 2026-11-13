import { headBlob, NsfwLevel } from '@civitai/orchestration-client';
import { env } from '~/env/server';
import { logToAxiom, safeError } from '~/server/logging/client';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { parseBlobVerdictHeaders } from '~/shared/orchestrator/blob-verdict-headers';

export const MAX_BLOB_RATING_BATCH = 32;

/** `nsfwLevel` is null when the blob has no level yet: `NA` covers both "not scanned" and "none". */
export type BlobRating = { blobId: string; nsfwLevel: NsfwLevel | null };

const LOOKUP_TIMEOUT_MS = 5_000;

const ratedLevels = new Set<string>(Object.values(NsfwLevel).filter((l) => l !== NsfwLevel.NA));

/** A failed lookup reads as unrated, so this never blocks anything on its own. */
export async function getBlobRatingsService({
  token,
  blobIds,
}: {
  token: string;
  blobIds: string[];
}): Promise<BlobRating[]> {
  const client = createOrchestratorClient(token);
  const unique = [...new Set(blobIds)].slice(0, MAX_BLOB_RATING_BATCH);

  return Promise.all(
    unique.map(async (blobId): Promise<BlobRating> => {
      try {
        const { response } = await headBlob({
          client,
          path: { blobId },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
        const verdict = response
          ? parseBlobVerdictHeaders(response.headers, response.status)
          : null;
        const level = verdict?.status === 'rated' ? verdict.nsfwLevel : null;
        return { blobId, nsfwLevel: level && ratedLevels.has(level) ? (level as NsfwLevel) : null };
      } catch (error) {
        logToAxiom({
          type: 'warning',
          name: 'blob-rating-lookup-failed',
          blobId,
          error: safeError(error),
        });
        return { blobId, nsfwLevel: null };
      }
    })
  );
}

/**
 * A blob's verdict as App Block media serving needs it. `location` is where a
 * visible blob is served from (the HEAD's redirect target).
 */
export type BlobState =
  | { verdict: 'pending' }
  | {
      verdict: 'rated';
      nsfwLevel: string | null;
      blockedReason: string | null;
      location: string | null;
    };

const BLOB_STATE_TTL_SECONDS = 60;
const BLOB_STATE_BACKOFF_SECONDS = 5;
const BLOB_STATE_HEAD_TIMEOUT_MS = 2_000;

const stateKey = (blobId: string) =>
  `${REDIS_KEYS.CACHES.BLOCK_MEDIA_BLOB_STATE}:${blobId}` as RedisKeyTemplateCache;
const backoffKey = (blobId: string) =>
  `${REDIS_KEYS.CACHES.BLOCK_MEDIA_BLOB_STATE_BACKOFF}:${blobId}` as RedisKeyTemplateCache;

/**
 * One HEAD with the system token, never waiting long: the orchestrator holds a
 * HEAD open until the scan has a verdict, so a timeout means pending. Only a
 * verdict is cached; a failed or timed-out read backs off for 5 s, so an outage
 * costs at most one HEAD per blob per 5 s. Never throws.
 *
 * A cached verdict can be up to ~120 s old, not 60: `fetchThroughCache` keeps
 * entries for twice the TTL and serves the stale one while another request
 * holds the refresh.
 */
export async function readBlobState(blobId: string): Promise<BlobState> {
  if (await redis.exists(backoffKey(blobId)).catch(() => 0)) return { verdict: 'pending' };

  try {
    return await fetchThroughCache(stateKey(blobId), () => headBlobState(blobId), {
      ttl: BLOB_STATE_TTL_SECONDS,
      retryCount: 0,
    });
  } catch {
    // No verdict, a failed HEAD (already backed off), or another request holding the refill.
    return { verdict: 'pending' };
  }
}

class NoVerdict extends Error {}

async function headBlobState(blobId: string): Promise<BlobState> {
  let response: Response | undefined;
  try {
    ({ response } = await headBlob({
      client: createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN),
      path: { blobId },
      signal: AbortSignal.timeout(BLOB_STATE_HEAD_TIMEOUT_MS),
    }));
  } catch (error) {
    await backOff(blobId, error);
    throw new NoVerdict();
  }
  const verdict = response
    ? parseBlobVerdictHeaders(response.headers, response.status)
    : ({ status: 'unavailable', httpStatus: 0 } as const);
  if (verdict.status === 'pending') throw new NoVerdict();
  if (verdict.status === 'unavailable') {
    await backOff(blobId, new Error(`blob HEAD ${verdict.httpStatus}`));
    throw new NoVerdict();
  }
  return {
    verdict: 'rated',
    nsfwLevel: verdict.nsfwLevel,
    blockedReason: verdict.blockedReason,
    location: verdict.location,
  };
}

async function backOff(blobId: string, error: unknown) {
  await redis
    .setNxKeepTtlWithEx(backoffKey(blobId), '1', BLOB_STATE_BACKOFF_SECONDS)
    .catch(() => undefined);
  // A timeout is the ordinary pending case: the HEAD waits for the scan.
  if (error instanceof Error && error.name === 'TimeoutError') return;
  logToAxiom({ type: 'warning', name: 'block-media-blob-state-failed', error: safeError(error) });
}
