import { REDIS_SYS_KEYS } from '@civitai/redis';
import { parseServiceStatus, type TrainingServiceStatus } from '$lib/service-status-core';
import { getSysRedis } from './redis';

const READ_DEADLINE_MS = 2000;

/** The same sys-redis value the main app's `training.getStatus` serves. Fails open (available, no
 *  message) on a redis error or a slow read, like the main app's reader. */
export async function getTrainingServiceStatus(): Promise<TrainingServiceStatus> {
  try {
    const raw = await Promise.race([
      getSysRedis().hGet<string>(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.TRAINING.STATUS),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_DEADLINE_MS)),
    ]);
    return parseServiceStatus(raw ? JSON.parse(String(raw)) : null);
  } catch {
    return parseServiceStatus(null);
  }
}
