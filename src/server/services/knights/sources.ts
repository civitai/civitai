import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  parseKnightsSourcesConfig,
  type KnightsSourcesConfig,
} from '@civitai/shared/new-order';
import { kyselyWrite } from '~/server/db/kyselyDb';
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

let cached: { config: KnightsSourcesConfig; expiresAt: number } | null = null;

export function clearKnightsSourcesConfigCache() {
  cached = null;
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

async function enqueueFromSource(
  type: string,
  source: string,
  item: { imageId: number; priority: 1 | 2 | 3 },
  shouldEnqueue: (config: KnightsSourcesConfig) => boolean
): Promise<void> {
  try {
    const config = await getKnightsSourcesConfig();
    if (!config.enabled || !shouldEnqueue(config)) return;
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
    (config) => random() < (nsfw ? config.nsfwRate : config.sfwRate)
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
