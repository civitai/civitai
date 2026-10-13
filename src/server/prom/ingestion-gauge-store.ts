import { isNonProductionDatabase } from '~/env/database-target';
import { setIngestionGaugeSharedStore, type IngestionGaugeSharedStore } from '~/server/prom/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

const SNAPSHOT_KEY = REDIS_SYS_KEYS.SYSTEM.IMAGE_INGESTION_GAUGES;
const LOCK_KEY = `${SNAPSHOT_KEY}:lock` as const;

type StoreRedis = Pick<NonNullable<typeof sysRedis>, 'get' | 'set'>;

// sysRedis, not the cache client: the election lock must not be evictable. Every call is raced
// against the sys read deadline because the refresh awaits it, and a half-open connection would
// otherwise park it for minutes and stop this process refreshing at all.
export function createIngestionGaugeStore(redis: StoreRedis): IngestionGaugeSharedStore {
  return {
    read: () => withSysReadDeadline(redis.get(SNAPSHOT_KEY)),
    tryLock: async (ttlMs) =>
      (await withSysReadDeadline(redis.set<string>(LOCK_KEY, '1', { NX: true, PX: ttlMs }))) ===
      'OK',
    write: async (value, ttlMs) => {
      await withSysReadDeadline(redis.set(SNAPSHOT_KEY, value, { PX: ttlMs }));
    },
  };
}

// sys keys carry no environment segment and several deployments share one sysRedis, so only
// deployments on the production database may share the production snapshot. The rest keep
// computing their own.
export function installIngestionGaugeStore(env: NodeJS.ProcessEnv = process.env) {
  if (!sysRedis || isNonProductionDatabase(env)) return false;
  setIngestionGaugeSharedStore(createIngestionGaugeStore(sysRedis));
  return true;
}

installIngestionGaugeStore();
