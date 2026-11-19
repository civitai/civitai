import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  knightsSourcesMaxOpen,
  parseKnightsSourcesConfig,
  type KnightsSourcesConfig,
} from '@civitai/shared/new-order';
import { countOpenServableKnightItems } from '@civitai/db/knights';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  enqueueKnightsItems,
  type EnqueueOptions,
} from '~/server/services/knights/enqueue.service';
import {
  KNIGHTS_SAMPLE_ENQUEUE_OPTIONS,
  KNIGHTS_SOURCE_SCAN_SAMPLE,
  knightsSampleDraw,
} from '~/server/services/knights/sampling';

export { KNIGHTS_SOURCE_SCAN_SAMPLE };
export const KNIGHTS_SOURCE_OWNER_RATING = 'owner-rating';

export { parseKnightsSourcesConfig, type KnightsSourcesConfig };

const OFF = parseKnightsSourcesConfig(null);

const CONFIG_TTL_MS = 30_000;
const CONFIG_READ_TIMEOUT_MS = 500;
const TIMED_OUT = Symbol('timed-out');

const OPEN_COUNT_TTL_MS = 60_000;
const OPEN_COUNT_TIMEOUT_MS = 500;
const OPEN_COUNT_BACKOFF_MS = 10_000;

let cached: { config: KnightsSourcesConfig; expiresAt: number } | null = null;
let openCount: { open: number; limit: number; expiresAt: number } | null = null;
/** The count in flight, until its query settles: a scan that stops waiting on it does not end it. */
let openCountRead: Promise<number | null> | null = null;
let openCountFailedUntil = 0;
let slowCountLoggedUntil = 0;

/** Clears the cached switch and everything the open-item count remembers. */
export function clearKnightsSourcesConfigCache() {
  cached = null;
  openCount = null;
  openCountRead = null;
  openCountFailedUntil = 0;
  slowCountLoggedUntil = 0;
}

/** Called from the image-scan result path; must never block it. A read that times out counts as off. */
export async function getKnightsSourcesConfig(): Promise<KnightsSourcesConfig> {
  return (await readKnightsSourcesConfig()) ?? OFF;
}

/**
 * The switch, or null when the read timed out: unknown, not off. A failed read throws. The publish sweep keeps its cursor
 * on null instead of moving past a window it never sampled.
 */
export async function readKnightsSourcesConfig(): Promise<KnightsSourcesConfig | null> {
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), CONFIG_READ_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([
      sysRedis.get(REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES),
      timedOut,
    ]);
    // Don't cache the timeout: it would turn sampling off for a full TTL.
    if (raw === TIMED_OUT) return null;
    const config = parseKnightsSourcesConfig(raw);
    cached = { config, expiresAt: Date.now() + CONFIG_TTL_MS };
    return config;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open servable Knight-stage rating items (`countOpenServableKnightItems`), counted only up to `limit`. Yes/no questions share
 * the queue table but not this intake: an imported backlog must not stop sampling. Cached for a minute whenever the query
 * lands; a failure is not cached and pauses counting for `OPEN_COUNT_BACKOFF_MS`.
 */
function startOpenCount(limit: number): Promise<number | null> {
  const read: Promise<number | null> = countOpenServableKnightItems(kyselyRead, limit)
    .then((open) => {
      if (openCountRead === read)
        openCount = { open, limit, expiresAt: Date.now() + OPEN_COUNT_TTL_MS };
      return open;
    })
    .catch(async (error: Error) => {
      if (openCountRead === read) openCountFailedUntil = Date.now() + OPEN_COUNT_BACKOFF_MS;
      logToAxiom(
        { type: 'knights-v2-open-count-error', error: error.message },
        'knights-v2-sources'
      );
      return null;
    })
    .finally(() => {
      if (openCountRead === read) openCountRead = null;
    });
  openCountRead = read;
  return read;
}

/**
 * Null when the count is unknown (failed, backing off, or slower than `OPEN_COUNT_TIMEOUT_MS`): the cap then does not apply.
 * Concurrent scans share the one count in flight; a scan that stops waiting leaves it running to fill the cache.
 */
async function openKnightItems(limit: number): Promise<number | null> {
  const now = Date.now();
  if (openCount && openCount.limit === limit && openCount.expiresAt > now) return openCount.open;
  if (now < openCountFailedUntil) return null;

  const read = openCountRead ?? startOpenCount(limit);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), OPEN_COUNT_TIMEOUT_MS);
  });
  try {
    const open = await Promise.race([read, timedOut]);
    if (open !== TIMED_OUT) return open;
    if (Date.now() >= slowCountLoggedUntil) {
      slowCountLoggedUntil = Date.now() + OPEN_COUNT_TTL_MS;
      logToAxiom(
        { type: 'knights-v2-open-count-slow', timeoutMs: OPEN_COUNT_TIMEOUT_MS },
        'knights-v2-sources'
      );
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function overIntakeCap(config: KnightsSourcesConfig): Promise<boolean> {
  const maxOpen = knightsSourcesMaxOpen(config);
  const open = await openKnightItems(maxOpen + 1);
  return open !== null && open > maxOpen;
}

async function enqueueFromSource(
  type: string,
  source: string,
  item: { imageId: number; priority: 1 | 2 | 3 },
  options: EnqueueOptions,
  shouldEnqueue: (config: KnightsSourcesConfig) => boolean | Promise<boolean>
): Promise<void> {
  try {
    const config = await getKnightsSourcesConfig();
    if (!config.enabled || !(await shouldEnqueue(config))) return;
    await enqueueKnightsItems(
      kyselyWrite,
      {
        source,
        questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
        items: [item],
      },
      undefined,
      options
    );
  } catch (error) {
    logToAxiom(
      { type, imageId: item.imageId, error: (error as Error).message },
      'knights-v2-sources'
    );
  }
}

/**
 * Samples a scanned image whose post is already live; one on a draft or scheduled post is refused (`unpublished`) and
 * left to the publish sweep (`sampleNewlyLivePostsForKnights`), which samples it when the post goes live.
 */
export function queueScanSampleForKnights(
  { imageId, nsfw }: { imageId: number; nsfw: boolean },
  draw: (imageId: number) => number = knightsSampleDraw
): Promise<void> {
  return enqueueFromSource(
    'knights-v2-scan-sample-error',
    KNIGHTS_SOURCE_SCAN_SAMPLE,
    { imageId, priority: nsfw ? 2 : 1 },
    KNIGHTS_SAMPLE_ENQUEUE_OPTIONS,
    // Only sampling is throttled: owner ratings below always enqueue.
    async (config) =>
      draw(imageId) < (nsfw ? config.nsfwRate : config.sfwRate) && !(await overIntakeCap(config))
  );
}

export function queueOwnerRatingForKnights(imageId: number): Promise<void> {
  return enqueueFromSource(
    'knights-v2-owner-rating-error',
    KNIGHTS_SOURCE_OWNER_RATING,
    { imageId, priority: 1 },
    { requirePost: true, stillImagesOnly: true },
    () => true
  );
}
