// Server-only: the client-safe parse and decision are in $lib/dataset-rating.
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { refreshBlob } from '@civitai/orchestration-client';
import type { SessionUser } from '@civitai/auth';
import { logToAxiom, safeError } from './axiom';
import { flagVariant } from './flipt';
import { orchestratorClient } from './orchestrator';
import { mainAppRateImage } from './main-app-rating';
import { getSysRedis } from './redis';
import {
  isStoredRating,
  parseMatureLevel,
  RATER_MODEL,
  type DatasetRating,
  type StoredRating,
} from '$lib/dataset-rating';
import { extOfAir, mediaOfExt } from '$lib/media';
import type { OrchestratorClient } from '$lib/orchestrator-core';

/** Variant flag: off, or no variant this code knows, means datasets are counted from the upload rating. */
export const DATASET_RATING_FLAG = 'trainingStudioDatasetRatingV2';

/** How long one dataset's rating job may run. Images it doesn't reach stay unrated (upload rating). */
export const DATASET_RATING_DEADLINE_MS = 30_000;
/** Rating calls in flight per job. */
export const DATASET_RATING_CONCURRENCY = 2;
/** Per user per UTC day, across pods: images sent to the rater, and Review's count requests. */
export const DATASET_RATING_DAILY_CALLS = 1000;
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
const SENT_KEY = REDIS_SYS_KEYS.TRAINING.STUDIO_DATASET_RATING_SENT;
/** How long a blob sent to the rater is not sent again, whatever came back. */
const SENT_TTL_SECONDS = 7 * 24 * 60 * 60;
// By rater and mature level: a verdict at one level is not a verdict at another. Blob ids are
// case-insensitive.
const cacheKey = (level: number, blobId: string) =>
  `${KEY}:${RATER_MODEL}:m${level}:${blobId.trim().toLowerCase()}` as const;

const sentKey = (level: number, blobId: string) =>
  `${SENT_KEY}:${RATER_MODEL}:m${level}:${blobId.trim().toLowerCase()}` as const;

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
  return { matureLevel, read: (blobKeys) => readRatings(matureLevel, blobKeys) };
}

async function readRatings(level: number, blobKeys: string[]): Promise<Map<string, StoredRating>> {
  const ratings = new Map<string, StoredRating>();
  if (blobKeys.length === 0) return ratings;
  try {
    const values = await getSysRedis().packed.mGet<unknown>(
      blobKeys.map((k) => cacheKey(level, k))
    );
    values.forEach((value, i) => {
      if (isStoredRating(value)) ratings.set(blobKeys[i]!, value);
    });
  } catch (err) {
    console.warn('[training-studio] dataset rating cache read failed', safeError(err));
  }
  return ratings;
}

async function writeRating(level: number, blobKey: string, rating: StoredRating): Promise<void> {
  try {
    await getSysRedis().packed.set(cacheKey(level, blobKey), rating, { EX: CACHE_TTL_SECONDS });
  } catch {
    // best-effort: the image stays unrated and the next job rates it again
  }
}

type RateResult =
  | { rating: StoredRating }
  /** `notSent`: nothing reached the rater, so the blob may be sent again. */
  | { rating: null; retryAfterMs?: number; limited?: boolean; notSent?: true };

/** Blob ids are base32 keys, optionally with a file extension; anything else is never sent. */
const BLOB_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/;

/** Only an image extension the uploader accepts; a key with no extension says nothing about its media. */
export const isRateableKey = (blobId: string): boolean => {
  const ext = extOfAir(blobId);
  return ext !== undefined && mediaOfExt(ext) === 'image';
};

/** Who a rating is for: the user's orchestrator client, their session cookie for the main app, and
 *  their mature level, which keys the cache (the main app reads the same flag for its verdict). */
export interface RatingCaller {
  client: OrchestratorClient;
  cookie: string;
  matureLevel: number;
}

/** One image through the v2 rater, free to the user; the main app scans on the system token. The blob
 *  id is the only gate: any token can refresh any blob, so this proves nothing about ownership, and the
 *  per-user and global caps are what bound the cost. Anything but a verdict is null. */
export async function rateImage(
  caller: RatingCaller,
  blobId: string,
  signal: AbortSignal
): Promise<RateResult> {
  if (!BLOB_ID.test(blobId)) return { rating: null, notSent: true };
  let url: string | null | undefined;
  try {
    url = (await refreshBlob({ client: caller.client, path: { blobId }, signal })).data?.url;
  } catch {
    return { rating: null, notSent: true };
  }
  if (!url) return { rating: null, notSent: true };
  try {
    const answer = await mainAppRateImage(caller.cookie, blobId, url, caller.matureLevel, signal);
    if (!answer) return { rating: null };
    if ('refused' in answer) return { rating: null, notSent: true };
    if ('limited' in answer)
      return { rating: null, limited: true, retryAfterMs: answer.retryAfterMs, notSent: true };
    return answer.mature === null ? { rating: null } : { rating: { mature: answer.mature } };
  } catch {
    return { rating: null };
  }
}

/** Claim a blob's one send per SENT_TTL_SECONDS, so a call that failed after reaching the rater, or never
 *  answered, is not sent again by every view, poll and pod. A Redis failure claims nothing. */
async function claimSend(level: number, blobKey: string): Promise<boolean> {
  try {
    const set = await getSysRedis().set(sentKey(level, blobKey), '1', {
      NX: true,
      EX: SENT_TTL_SECONDS,
    });
    return set !== null;
  } catch {
    return false;
  }
}

/** The keys with no sent marker. A Redis failure answers none, like claimSend. */
async function unsentKeys(level: number, blobKeys: string[]): Promise<string[]> {
  if (blobKeys.length === 0) return [];
  try {
    const sent = await getSysRedis().mGet(blobKeys.map((k) => sentKey(level, k)));
    return blobKeys.filter((_, i) => sent[i] == null);
  } catch {
    return [];
  }
}

async function releaseSend(level: number, blobKey: string): Promise<void> {
  try {
    await getSysRedis().del(sentKey(level, blobKey));
  } catch {
    // best-effort: the blob waits out the marker on its upload rating
  }
}

export interface RatingJobSummary {
  images: number;
  /** Keys never sent because they aren't images (see isRateableKey); not in `calls` or `fallbacks`. */
  skipped: number;
  /** Images sent within SENT_TTL_SECONDS by an earlier job: not sent again, and not in `calls`. */
  alreadySent: number;
  calls: number;
  rated: number;
  fallbacks: number;
  rateLimited: number;
  deadlineHit: boolean;
  ms: number;
}

/** Rate the images among `blobKeys` (all readable by the caller, none rated yet) within the deadline,
 *  storing each OK rating. An image whose call fails, is rate-limited or isn't reached stays unrated. */
export async function runRatingJob(
  caller: RatingCaller,
  blobKeys: string[],
  rate: typeof rateImage = rateImage,
  deadlineMs: number = DATASET_RATING_DEADLINE_MS
): Promise<RatingJobSummary> {
  const started = Date.now();
  const images = blobKeys.filter(isRateableKey);
  const deadline = started + deadlineMs;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadlineMs);
  let next = 0;
  let calls = 0;
  let alreadySent = 0;
  let rated = 0;
  let rateLimited = 0;
  let pausedUntil = 0;
  const worker = async () => {
    while (next < images.length && Date.now() < deadline && !abort.signal.aborted) {
      if (pausedUntil > Date.now()) {
        await new Promise((r) => setTimeout(r, Math.min(pausedUntil, deadline) - Date.now()));
        continue;
      }
      const key = images[next++]!;
      if (!(await claimSend(caller.matureLevel, key))) {
        alreadySent++;
        continue;
      }
      calls++;
      const result = await rate(caller, key, abort.signal);
      if (!result.rating && result.notSent) await releaseSend(caller.matureLevel, key);
      if (result.rating) {
        rated++;
        await writeRating(caller.matureLevel, key, result.rating);
      } else if (result.limited) {
        rateLimited++;
        pausedUntil = Math.max(pausedUntil, Date.now() + (result.retryAfterMs ?? 1000));
      }
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(DATASET_RATING_CONCURRENCY, images.length) }, worker)
    );
  } finally {
    clearTimeout(timer);
  }
  return {
    images: blobKeys.length,
    skipped: blobKeys.length - images.length,
    alreadySent,
    calls,
    rated,
    fallbacks: images.length - rated,
    rateLimited,
    deadlineHit: next < images.length || abort.signal.aborted,
    ms: Date.now() - started,
  };
}

const activeJobs = new Map<number, Promise<void>>();

/** Start rating a dataset's unrated images in the background, one job per user per pod at a time (a
 *  second call while one runs starts nothing; Review asks again). Never throws. */
export function warmDatasetRating(
  token: string,
  userId: number,
  matureLevel: number,
  blobKeys: string[],
  cookie: string | null,
  deadlineMs: number = DATASET_RATING_DEADLINE_MS
): void {
  const images = blobKeys.filter(isRateableKey);
  // No session to call the main app with (the dev-login preview): nothing is rated.
  if (cookie === null || images.length === 0 || activeJobs.has(userId)) return;
  const job = unsentKeys(matureLevel, images)
    .then(async (unsent) => {
      // Allowance only for images that will be sent: one already sent never takes a slot.
      const { granted, key } = await claimAllowance('calls', userId, unsent.length);
      const summary = await runRatingJob(
        { client: orchestratorClient(token), cookie, matureLevel },
        unsent.slice(0, granted),
        rateImage,
        deadlineMs
      );
      // Images the job didn't reach go back to today's allowance, for the next look.
      await returnDaily(key, granted - summary.calls);
      // alreadySent is not an Axiom field on this dataset, so it rides in payload.
      const { alreadySent, ...counts } = summary;
      void logToAxiom({
        name: 'training-studio-dataset-rating',
        type: 'info',
        message: 'dataset rating job',
        userId,
        ...counts,
        images: blobKeys.length,
        skipped: blobKeys.length - images.length,
        overDailyCap: unsent.length - granted,
        payload: { alreadySent: alreadySent + images.length - unsent.length },
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
