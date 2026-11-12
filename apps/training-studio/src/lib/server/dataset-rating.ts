// Server half of the v2 dataset rating: the flag, the shared cache, and the background job that rates a
// dataset's images ahead of the submit. The decision itself is in $lib/dataset-rating + train-core.
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { invokeImageScanningStepTemplate } from '@civitai/orchestration-client';
import type { SessionUser } from '@civitai/auth';
import { logToAxiom, safeError } from './axiom';
import { flagVariant } from './flipt';
import { orchestratorClient } from './orchestrator';
import { getSysRedis } from './redis';
import {
  isStoredRating,
  parseMatureLevel,
  parseRatingV2,
  RATER_MODEL,
  type DatasetRating,
  type RatingV2ScanInput,
  type StoredRating,
} from '$lib/dataset-rating';
import type { OrchestratorClient } from '$lib/orchestrator-core';

/** Variant flag: off, or no variant this code knows, means datasets are counted from the upload rating. */
export const DATASET_RATING_FLAG = 'trainingStudioDatasetRatingV2';

/** How long one dataset's rating job may run. Images it doesn't reach stay unrated (upload rating). */
export const DATASET_RATING_DEADLINE_MS = 30_000;
/** Rating calls in flight per job. */
export const DATASET_RATING_CONCURRENCY = 2;
/** Per user per UTC day, across pods: images sent to the rater, and Review's count requests. */
export const DATASET_RATING_DAILY_CALLS = 3000;
export const DATASET_RATING_DAILY_LOOKUPS = 300;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const KEY = REDIS_SYS_KEYS.TRAINING.STUDIO_DATASET_RATING;
const DAILY_KEY = REDIS_SYS_KEYS.TRAINING.STUDIO_DATASET_RATING_DAILY;
// By rater, so a different rater's results are never read as this one's. Blob ids are case-insensitive.
const cacheKey = (blobId: string) =>
  `${KEY}:${RATER_MODEL}:${blobId.trim().toLowerCase()}` as const;

/** Take up to `want` units of today's `kind` allowance for this user; returns how many were granted.
 *  A Redis failure grants none, which leaves images on their upload rating. */
export async function claimDaily(
  kind: 'calls' | 'lookups',
  userId: number,
  want: number
): Promise<number> {
  if (want <= 0) return 0;
  const limit = kind === 'calls' ? DATASET_RATING_DAILY_CALLS : DATASET_RATING_DAILY_LOOKUPS;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${DAILY_KEY}:${kind}:${userId}:${day}` as const;
  try {
    const redis = getSysRedis();
    const total = await redis.incrBy(key, want);
    if (total === want) await redis.expire(key, 2 * 24 * 60 * 60);
    const granted = Math.max(0, Math.min(want, limit - (total - want)));
    if (granted < want) await redis.decrBy(key, want - granted).catch(() => undefined);
    return granted;
  } catch {
    return 0;
  }
}

/** The v2 rating for this user's datasets, or undefined when it is off for them. */
export async function datasetRatingFor(user: SessionUser): Promise<DatasetRating | undefined> {
  const matureLevel = parseMatureLevel(await flagVariant(DATASET_RATING_FLAG, user));
  if (matureLevel === null) return undefined;
  return { matureLevel, read: readRatings };
}

async function readRatings(blobKeys: string[]): Promise<Map<string, StoredRating>> {
  const ratings = new Map<string, StoredRating>();
  if (blobKeys.length === 0) return ratings;
  try {
    const values = await getSysRedis().packed.mGet<unknown>(blobKeys.map((k) => cacheKey(k)));
    values.forEach((value, i) => {
      if (isStoredRating(value)) ratings.set(blobKeys[i]!, value);
    });
  } catch (err) {
    console.warn('[training-studio] dataset rating cache read failed', safeError(err));
  }
  return ratings;
}

async function writeRating(blobKey: string, rating: StoredRating): Promise<void> {
  try {
    await getSysRedis().packed.set(cacheKey(blobKey), rating, { EX: CACHE_TTL_SECONDS });
  } catch {
    // best-effort: the image stays unrated and the next job rates it again
  }
}

type RateResult =
  | { rating: StoredRating }
  | { rating: null; retryAfterMs?: number; limited?: boolean };

/** One image through the v2 rater. Anything but a parsed OK rating is null. */
export async function rateImage(
  client: OrchestratorClient,
  blobKey: string,
  signal: AbortSignal
): Promise<RateResult> {
  const body: RatingV2ScanInput = { image: blobKey, 'rater-model': RATER_MODEL };
  try {
    const { data, response } = await invokeImageScanningStepTemplate({ client, body, signal });
    if (response?.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      return {
        rating: null,
        limited: true,
        retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000,
      };
    }
    const rating = parseRatingV2(data);
    return rating ? { rating } : { rating: null };
  } catch {
    return { rating: null };
  }
}

export interface RatingJobSummary {
  images: number;
  calls: number;
  rated: number;
  fallbacks: number;
  rateLimited: number;
  deadlineHit: boolean;
  ms: number;
}

/** Rate `blobKeys` (all readable by the caller, none rated yet) within the deadline, storing each OK
 *  rating. An image whose call fails, is rate-limited or isn't reached stays unrated. */
export async function runRatingJob(
  client: OrchestratorClient,
  blobKeys: string[],
  rate: typeof rateImage = rateImage,
  deadlineMs: number = DATASET_RATING_DEADLINE_MS
): Promise<RatingJobSummary> {
  const started = Date.now();
  const deadline = started + deadlineMs;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadlineMs);
  let next = 0;
  let calls = 0;
  let rated = 0;
  let rateLimited = 0;
  let pausedUntil = 0;
  const worker = async () => {
    while (next < blobKeys.length && Date.now() < deadline) {
      if (pausedUntil > Date.now()) {
        await new Promise((r) => setTimeout(r, Math.min(pausedUntil, deadline) - Date.now()));
        continue;
      }
      const key = blobKeys[next++]!;
      calls++;
      const result = await rate(client, key, abort.signal);
      if (result.rating) {
        rated++;
        await writeRating(key, result.rating);
      } else if (result.limited) {
        rateLimited++;
        pausedUntil = Math.max(pausedUntil, Date.now() + (result.retryAfterMs ?? 1000));
      }
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(DATASET_RATING_CONCURRENCY, blobKeys.length) }, worker)
    );
  } finally {
    clearTimeout(timer);
  }
  return {
    images: blobKeys.length,
    calls,
    rated,
    fallbacks: blobKeys.length - rated,
    rateLimited,
    deadlineHit: next < blobKeys.length || abort.signal.aborted,
    ms: Date.now() - started,
  };
}

const activeJobs = new Map<number, Promise<void>>();

/** Start rating a dataset's unrated images in the background, one job per user per pod at a time (a
 *  second call while one runs starts nothing; Review asks again). Never throws. */
export function warmDatasetRating(token: string, userId: number, blobKeys: string[]): void {
  if (blobKeys.length === 0 || activeJobs.has(userId)) return;
  const job = claimDaily('calls', userId, blobKeys.length)
    .then((granted) => runRatingJob(orchestratorClient(token), blobKeys.slice(0, granted)))
    .then((summary) => {
      void logToAxiom({
        name: 'training-studio-dataset-rating',
        type: 'info',
        message: 'dataset rating job',
        userId,
        ...summary,
        overDailyCap: blobKeys.length - summary.images,
      });
    })
    .catch((err) => {
      void logToAxiom({
        name: 'training-studio-dataset-rating',
        type: 'error',
        message: 'dataset rating job failed',
        userId,
        error: safeError(err),
      });
    })
    .finally(() => activeJobs.delete(userId));
  activeJobs.set(userId, job);
}
