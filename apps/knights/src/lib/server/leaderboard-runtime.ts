import { createBoardCache } from './leaderboard-cache';
import { getSysRedis } from './redis';

// The sys client types its keys as a closed union; this key is the app's own, so it is cast here.
export const boardCache = createBoardCache({
  get: (key) => getSysRedis().get(key as never) as Promise<string | null>,
  set: async (key, value, ttlSeconds) => {
    await getSysRedis().set(key as never, value, { EX: ttlSeconds } as never);
  },
});
