import { getSysRedis } from '../redis';
import { redisSummaryStore } from './pending-summary';

// The sys client types its keys as a closed union; this key is the app's own, so it is cast here.
export const summaryStore = redisSummaryStore(() => {
  const client = getSysRedis();
  return {
    get: (key) => client.get(key as never) as Promise<string | null>,
    set: (key, value) => client.set(key as never, value),
  };
});
