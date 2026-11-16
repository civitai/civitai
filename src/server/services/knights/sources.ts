import { sql } from 'kysely';
import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  knightsSourcesMaxOpen,
  parseKnightsSourcesConfig,
  type KnightsSourcesConfig,
} from '@civitai/shared/new-order';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { enqueueKnightsItems } from '~/server/services/knights/enqueue.service';

export const KNIGHTS_SOURCE_SCAN_SAMPLE = 'scan-sample';
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

/** Called from the image-scan result path; must never block it. */
export async function getKnightsSourcesConfig(): Promise<KnightsSourcesConfig> {
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
    if (raw === TIMED_OUT) return OFF;
    const config = parseKnightsSourcesConfig(raw);
    cached = { config, expiresAt: Date.now() + CONFIG_TTL_MS };
    return config;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open Knight-stage items, counted only up to `limit` so the read stays short on the (status, minRank, ...) index. The result is
 * cached for a minute whenever the query lands. A failure is not cached and pauses counting for `OPEN_COUNT_BACKOFF_MS`.
 */
function startOpenCount(limit: number): Promise<number | null> {
  const read: Promise<number | null> = kyselyRead
    .selectFrom(
      kyselyRead
        .selectFrom('KnightsQueueItem')
        .select(sql<number>`1`.as('one'))
        .where('status', '=', 'Open')
        .where('minRank', '=', 'Knight')
        .limit(limit)
        .as('open')
    )
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow()
    .then((row) => {
      const open = Number(row.n);
      if (openCountRead === read)
        openCount = { open, limit, expiresAt: Date.now() + OPEN_COUNT_TTL_MS };
      return open;
    })
    .catch(async (error: Error) => {
      if (openCountRead === read) openCountFailedUntil = Date.now() + OPEN_COUNT_BACKOFF_MS;
      await logToAxiom(
        { type: 'knights-v2-open-count-error', error: error.message },
        'knights-v2-sources'
      ).catch(() => undefined);
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
      await logToAxiom(
        { type: 'knights-v2-open-count-slow', timeoutMs: OPEN_COUNT_TIMEOUT_MS },
        'knights-v2-sources'
      ).catch(() => undefined);
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
  shouldEnqueue: (config: KnightsSourcesConfig) => boolean | Promise<boolean>
): Promise<void> {
  try {
    const config = await getKnightsSourcesConfig();
    if (!config.enabled || !(await shouldEnqueue(config))) return;
    await enqueueKnightsItems(kyselyWrite, {
      source,
      questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
      items: [item],
    });
  } catch (error) {
    await logToAxiom(
      { type, imageId: item.imageId, error: (error as Error).message },
      'knights-v2-sources'
    ).catch(() => undefined);
  }
}

export function queueScanSampleForKnights(
  { imageId, nsfw }: { imageId: number; nsfw: boolean },
  random: () => number = Math.random
): Promise<void> {
  return enqueueFromSource(
    'knights-v2-scan-sample-error',
    KNIGHTS_SOURCE_SCAN_SAMPLE,
    { imageId, priority: nsfw ? 2 : 1 },
    // Only sampling is throttled: owner ratings below always enqueue.
    async (config) =>
      random() < (nsfw ? config.nsfwRate : config.sfwRate) && !(await overIntakeCap(config))
  );
}

export function queueOwnerRatingForKnights(imageId: number): Promise<void> {
  return enqueueFromSource(
    'knights-v2-owner-rating-error',
    KNIGHTS_SOURCE_OWNER_RATING,
    { imageId, priority: 1 },
    () => true
  );
}
