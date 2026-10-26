import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { AUTO_LABEL_SUBMIT_RATE_LIMIT } from '~/server/schema/training.schema';
import { checkFixedWindow } from '~/server/utils/fixed-window-rate-limit';

/** Count one Training Studio auto-label submit for `userId`. Fails CLOSED: the system pays per job. */
export function checkStudioAutoLabelRateLimit(userId: number) {
  return checkFixedWindow(
    `${REDIS_SYS_KEYS.TRAINING.STUDIO_AUTO_LABEL_LIMIT}:${userId}`,
    AUTO_LABEL_SUBMIT_RATE_LIMIT.limit,
    AUTO_LABEL_SUBMIT_RATE_LIMIT.period,
    { failOpen: false, client: sysRedis }
  );
}
