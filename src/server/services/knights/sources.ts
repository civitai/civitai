import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { enqueueKnightsItems } from '~/server/services/knights/enqueue.service';

export const KNIGHTS_SOURCE_SCAN_SAMPLE = 'scan-sample';
export const KNIGHTS_SOURCE_OWNER_RATING = 'owner-rating';

export type KnightsSourcesConfig = { enabled: boolean; sfwRate: number; nsfwRate: number };

const DEFAULT_RATES = { sfwRate: 1, nsfwRate: 0.3 };
const OFF: KnightsSourcesConfig = { enabled: false, ...DEFAULT_RATES };

const rate = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

export function parseKnightsSourcesConfig(raw: string | Buffer | null): KnightsSourcesConfig {
  if (raw == null) return OFF;
  try {
    const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return OFF;
    const config = parsed as Record<string, unknown>;
    return {
      enabled: config.enabled === true,
      sfwRate: rate(config.sfwRate, DEFAULT_RATES.sfwRate),
      nsfwRate: rate(config.nsfwRate, DEFAULT_RATES.nsfwRate),
    };
  } catch {
    return OFF;
  }
}

export async function getKnightsSourcesConfig(): Promise<KnightsSourcesConfig> {
  return parseKnightsSourcesConfig(await sysRedis.get(REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES));
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
