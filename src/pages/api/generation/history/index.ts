import dayjs from '~/shared/utils/dayjs';
import fetch from 'node-fetch';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { createLimiter } from '~/server/utils/rate-limiting';

const historyLimiter = createLimiter({
  counterKey: REDIS_KEYS.COUNTERS.HISTORY_DOWNLOADS,
  limitKey: REDIS_SYS_KEYS.LIMITS.HISTORY_DOWNLOADS,
  fetchCount: async () => 0,
  refetchInterval: CacheTTL.day,
});

export default AuthedEndpoint(async function handler(req, res, user) {
  const limitKey = user.id.toString();
  if (await historyLimiter.hasExceededLimit(limitKey)) {
    const limitHitTime = await historyLimiter.getLimitHitTime(limitKey);
    let message = 'Too many history download requests';
    if (limitHitTime)
      message += ` - Please try again ${dayjs(limitHitTime).add(1, 'day').fromNow()}.`;
    return res.status(429).send(message);
  }

  // const canDownload = new Date().getTime() < downloadGeneratedImagesByDate.getTime();
  // if (!canDownload) return res.status(400).send('download period has ended');

  // TODO @Briant is this file used anymore?

  const url =
    `https://image-generation-scheduler-dev.civitai.com/users/${user.id}/images/download?` +
    new URLSearchParams({
      concurrency: '16',
      startDate: '2023-01-01',
      endDate: '2025-01-01',
      callbackUrl: `${env.NEXTAUTH_URL}/api/generation/history/callback?userId=${user.id}`,
    });

  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to get download url: ${response.statusText}`);
  const preSignedUrl = await response.json();

  res.redirect(preSignedUrl);
});
