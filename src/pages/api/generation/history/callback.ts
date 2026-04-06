import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { createLimiter } from '~/server/utils/rate-limiting';
import { signalClient } from '~/utils/signal-client';

const historyLimiter = createLimiter({
  counterKey: REDIS_SYS_KEYS.COUNTERS.HISTORY_DOWNLOADS,
  limitKey: REDIS_SYS_KEYS.LIMITS.HISTORY_DOWNLOADS,
  fetchCount: async () => 0,
  refetchInterval: CacheTTL.day,
});

const schema = z.object({ userId: z.coerce.number() });

export default PublicEndpoint(async function handler(req, res) {
  const { userId } = schema.parse(req.query);
  const limitKey = userId.toString();

  await historyLimiter.increment(limitKey);

  await signalClient.send({
    target: SignalMessages.SchedulerDownload,
    data: { downloading: false },
    userId,
  });

  return res.json({ ok: true });
});
