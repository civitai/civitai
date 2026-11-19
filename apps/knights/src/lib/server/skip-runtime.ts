import { getSysRedis } from './redis';
import { redisSkipStore } from './skips';

export const skipStore = redisSkipStore(getSysRedis);
