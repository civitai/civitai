// Server-only: the client-safe parse and decision are in $lib/dataset-rating.
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
/** Per user per UTC day: dataset files Review reads to see whether they're ready to train. */
export const UPLOAD_READINESS_DAILY_PROBES = 20_000;

type DailyKind = 'calls' | 'lookups' | 'probes';
const DAILY_LIMITS: Record<DailyKind, number> = {
  calls: DATASET_RATING_DAILY_CALLS,
  lookups: DATASET_RATING_DAILY_LOOKUPS,
  probes: UPLOAD_READINESS_DAILY_PROBES,
};
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const KEY = REDIS_SYS_KEYS.TRAINING.STUDIO_DATASET_RATING;
const DAILY_KEY = REDIS_SYS_KEYS.TRAINING.STUDIO_DATASET_RATING_DAILY;
// By rater, so a different rater's results are never read as this one's. Blob ids are case-insensitive.
const cacheKey = (blobId: string) =>
  `${KEY}:${RATER_MODEL}:${blobId.trim().toLowerCase()}` as const;

const dailyKey = (kind: DailyKind, userId: number) =>
  `${DAILY_KEY}:${kind}:${userId}:${new Date().toISOString().slice(0, 10)}` as const;

/** Take up to `want` units of today's `kind` allowance for this user: how many were granted, and the
 *  day's key they were taken from (a give-back must go to that day, not the day it finishes on). A
 *  Redis failure grants none, which leaves images on their upload rating. */
async function claimAllowance(
  kind: DailyKind,
  userId: number,
  want: number
): Promise<{ granted: number; key: ReturnType<typeof dailyKey> }> {
  const key = dailyKey(kind, userId);
  if (want <= 0) return { granted: 0, key };
  const limit = DAILY_LIMITS[kind];
  try {
    const redis = getSysRedis();
    const total = await redis.incrBy(key, want);
    if (total === want) await redis.expire(key, 2 * 24 * 60 * 60);
    const granted = Math.max(0, Math.min(want, limit - (total - want)));
    if (granted < want) await redis.decrBy(key, want - granted).catch(() => undefined);
    return { granted, key };
  } catch {
    return { granted: 0, key };
  }
}

export async function claimDaily(kind: DailyKind, userId: number, want: number): Promise<number> {
  return (await claimAllowance(kind, userId, want)).granted;
}

/** Like claimDaily, with a way to give back units the caller didn't use (to the day they were claimed on). */
export async function claimDailyReturnable(
  kind: DailyKind,
  userId: number,
  want: number
): Promise<{ granted: number; giveBack: (n: number) => Promise<void> }> {
  const { granted, key } = await claimAllowance(kind, userId, want);
  return { granted, giveBack: (n) => returnDaily(key, Math.min(n, granted)) };
}

async function returnDaily(key: ReturnType<typeof dailyKey>, n: number): Promise<void> {
  if (n <= 0) return;
  try {
    await getSysRedis().decrBy(key, n);
  } catch {
    // best-effort: the allowance is just smaller for the rest of the day
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

/** The recipe's reference to an orchestrator blob: used as-is, with no import and no rescan. A bare id
 *  would be read as base64 image data and refused. */
export const scanImageRef = (blobId: string) => `urn:air:other:other:orchestrator:blob@${blobId}`;
/** Blob ids are base32 keys, optionally with a file extension; anything else is never put in an AIR. */
const BLOB_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/;

/** One image through the v2 rater. Anything but a parsed OK rating is null. */
export async function rateImage(
  client: OrchestratorClient,
  blobId: string,
  signal: AbortSignal
): Promise<RateResult> {
  if (!BLOB_ID.test(blobId)) return { rating: null };
  const body: RatingV2ScanInput = { image: scanImageRef(blobId), 'rater-model': RATER_MODEL };
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
    while (next < blobKeys.length && Date.now() < deadline && !abort.signal.aborted) {
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
export function warmDatasetRating(
  token: string,
  userId: number,
  blobKeys: string[],
  deadlineMs: number = DATASET_RATING_DEADLINE_MS
): void {
  if (blobKeys.length === 0 || activeJobs.has(userId)) return;
  const job = claimAllowance('calls', userId, blobKeys.length)
    .then(async ({ granted, key }) => {
      const summary = await runRatingJob(
        orchestratorClient(token),
        blobKeys.slice(0, granted),
        rateImage,
        deadlineMs
      );
      // Images the job didn't reach go back to today's allowance, for the next look.
      await returnDaily(key, granted - summary.calls);
      void logToAxiom({
        name: 'training-studio-dataset-rating',
        type: 'info',
        message: 'dataset rating job',
        userId,
        ...summary,
        overDailyCap: blobKeys.length - granted,
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
