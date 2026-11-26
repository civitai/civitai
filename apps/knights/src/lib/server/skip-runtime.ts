import { getCacheRedis } from './redis';
import { redisSkipStore } from './skips';

export const skipStore = redisSkipStore(getCacheRedis);
